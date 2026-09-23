import { basename, dirname, join as pathJoin, relative as pathRelative, resolve as pathResolve, sep } from 'node:path';
import { StepCache, frameScopedStepKey, cacheDirName, envCacheSegment } from '../cache/step-cache.js';
import { arraysEqual, chooseCacheHashSource } from './cache-hash-source.js';
import { ProjectBundleResolver, type ProjectBundle } from './project-bundle.js';
import {
  applyEnvToAiConfig,
  autoCapturedNames,
  buildEnrichedInstruction,
  isBrowserClosed,
  isSkippableStep,
  parseOutputPrefixes,
  UNATTENDED_SKIP_REASON,
} from './run-helpers.js';
import type { Config, EffectiveSettings, RunSettings } from '../config/types.js';
import { mergeRunSettings, resolveRunSettings } from '../config/run-settings.js';
import {
  describeViewportSource,
  resolveViewportSpec,
  viewportCdpConflictError,
} from '../config/viewport.js';
import { resolveTableStructure, tableStructureOf } from '../config/table-structure.js';
import { createStructureMemo } from '../runner/structure-memo.js';
import type { LoopMarker, StepResult, TestReport } from '../report/types.js';
// From report/TYPES, deliberately — not report/generator.js, which a dozen
// api-server suites replace wholesale with a three-export `vi.mock`.
import { isHealedStep } from '../report/types.js';
import { AiClient } from '../ai/client.js';
import { aiConfigured } from '../config/loader.js';
import { TokenTracker } from '../utils/tokens.js';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  launchBrowser,
  closeBrowser,
  BrowserTracker,
  NoBrowserLaunchedError,
  resolveVideoMode,
  finalizeMainPageVideo,
  briefly,
  type BrowserSession,
  type VideoMode,
} from '../browser/manager.js';
import { executeStep, executeBranchedStep } from '../runner/step-executor.js';
import type { StepExecutorOptions } from '../runner/step-executor.js';
import { identifyStepGroups } from '../runner/step-grouper.js';
import { parseUseStep } from '../parser/use-step.js';
import {
  SkillSurfaceStack,
  computerContextFor,
  defaultLoadDesktopAdapter,
  defaultProbeComputerCapture,
  enterComputerMode,
  executeComputerStep,
  leaveComputerMode,
  modeMarkerText,
  modeStepResult,
  skillFrameChain,
  undispatchedDirectiveError,
  undispatchedDirectiveResult,
  type SurfaceState,
} from '../runner/computer-step.js';
import type { ComputerLockOptions, DesktopAdapter } from '../desktop/index.js';
import type { VisionRouteAi, VisionRouteResult } from '../desktop/vision-route.js';
import {
  createControlState,
  firstLoopInRange,
  forEachPassOf,
  guardVisitEvaluates,
  loopCompileRefusal,
  planAfterStep,
  planForStart,
  returnExit,
  snapEndAt,
  type ControlRecord,
} from '../runner/control-flow.js';
import { dottedReferenceError } from '../runner/placeholder-substitution.js';
import {
  applyPassBindings,
  evaluateGuard,
  guardHistoryLines,
  guardResult,
  guardRows,
  eachSkipped,
  isLoopRecord,
  LoopRuntime,
  skipReasonFor,
  skippedResult,
  SkipQueue,
  type LoopRecord,
} from '../runner/control-runtime.js';
import { controlLineDefines, parseControlLine } from '../parser/control-line.js';
import { loadContextFiles } from '../context/loader.js';
import { interpolate } from '../parser/parameters.js';
import { parseSetStep } from '../parser/set-step.js';
import { runSetStep } from '../runner/set-step-runner.js';
import { isReturnClaim, parseFlowControlStep } from '../parser/flow-control-step.js';
import {
  failureTailContradictionError,
  isFailureTailContradiction,
  parseFailureTail,
} from '../parser/failure-tail.js';
import {
  deliberateFailError,
  deliberateFailResult,
  flowControlExplanation,
  frameExitIndex,
  frameLabel,
  skippedByReturn,
  skippedByReturnReason,
  toleratedHistoryLine,
  toleratedLogLine,
} from '../runner/flow-control.js';
import {
  envDataSecretValues,
  interpolateEnvData,
  type EnvDataContext,
} from '../parser/interpolate-env-data.js';
import { resolveDataSourcePath } from '../parser/markdown.js';
import { loadDataFromPath, type DataObject } from '../env/data-loader.js';
import {
  clearSkillCache,
  expandSkills,
  type ExpandedFrame,
  type ExpandedStepOrigin,
} from '../skills/expander.js';
import { buildCodeBehindRegistry, CodeBehindRegistry } from '../codebehind/loader.js';
import { writeLastRun, type LastRunStep } from '../codebehind/last-run.js';
import {
  recordingDirFor,
  spliceRecording,
  writeRecording,
  type RecordingInput,
} from '../codebehind/recording.js';
import { LiveCompiler } from '../codebehind/live-compile.js';
import type { CompilePhase, CompileStatus, CompileSummary } from '../codebehind/compile.js';
import { compileLock, compileLockKey } from './compile-lock.js';
import {
  inheritLoopBindings,
  loopBindingsOf,
  redact,
  redactReport,
  runSecrets,
} from '../utils/secrets.js';
import { parseToolCall } from '../tools/tool-call-parser.js';
import { executeToolStep } from '../tools/executor.js';
import { loadToolCatalogue, ToolCatalogue } from '../tools/registry.js';
import { formatStepHistoryEntry } from '../ai/prompts.js';
import { captureScreenshot } from '../browser/screenshot.js';
import {
  capturePageContent,
  type CapturedPageContent,
  type PageContentOptions,
} from './page-capture.js';
import { ApiResponseStore } from '../api/response-store.js';
import { parseTimeoutMs } from '../runner/test-runner.js';
import { generateReport, buildReportBaseName, videoBaseNameFor } from '../report/generator.js';
import { mergeRowReports, type RowReport, type UnrunRow } from '../report/merge-rows.js';

/**
 * The rows of one data-driven run, gathered across the batches that ran them
 * and rendered as a single report by `finalizeRowRun`.
 */
interface RowRunAccumulator {
  rows: RowReport[];
  /** Where the report goes — captured from the session that ran row 1, since
   *  the session is closed and recreated between rows. */
  reportOutputDir: string;
}
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
   *  about CDP attach. The runner validates the shape on receive.
   *
   *  `viewport` is the RAW `## Config: viewport:` string, not a resolved size
   *  (stories/per-test-viewport.md §3): the server owns the one validator, so
   *  clients stay dumb and every layer refuses the same values with the same
   *  words. Resolved at session creation, before the browser launches. */
  config?: {
    baseUrl?: string;
    timeout?: string;
    viewport?: string;
    /** Raw `## Config: unmask:` list — comma-separated parameter names and
     *  `${…}` refs this test declares are not secrets, despite `isSecretName`
     *  matching them (stories/placeholder-preserving-actions.md, decision 2).
     *  Only the prompt's `## Values` block reads it; report and log masking are
     *  untouched. */
    unmask?: string;
    /** Raw `## Config: tableStructure:` — `ask` (default) or `strict`
     *  (docs/specs/SPEC-structured-table-reads.md §7.10). Read per BATCH, like
     *  `unmask` and unlike `viewport`: it decides nothing about the browser,
     *  so there is no launch to anchor it to, and layering it over the
     *  project's `tables.structure` per batch is what makes a test's own key
     *  win on a server serving several projects. */
    tableStructure?: string;
    cdp?: { port: number; tab?: string; profile?: string };
  };
  steps: string[];
  parameters?: Record<string, string>;
  /**
   * Per-request environment variables (e.g. AI_API_KEY, AI_MODEL,
   * AI_GATEWAY_URL). Applied to the session's config only — never written to
   * the server's process.env, so concurrent sessions and the server itself
   * remain isolated. All three are re-applied to the session's AiClient at the
   * start of every batch (see `executeStepsInternal`), so a saved `.env` edit
   * is picked up on the next run without closing the session.
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
   * Which data row of a data-driven run this batch is, 1-based
   * (stories/data-driven-rows.md, part A). The client owns the loop — it runs
   * the rows in order, closing the session between them — and the server owns
   * only the report.
   *
   * A batch carrying `dataRow` writes NO report. It appends its step results
   * to a row accumulator on the manager and returns a `done` with no
   * `reportPath`; the client posts `POST /sessions/:id/report` when its loop
   * ends, and that renders the one report the run gets. Finalising has to be
   * its own call because the client cannot know which batch is the last one
   * until that batch comes back: a pause ends the loop after the current row,
   * Stop ends it mid-row, and a throw ends it there.
   */
  dataRow?: number;
  /** How many rows the run has. Required alongside `dataRow`. */
  dataRowCount?: number;
  /**
   * The row's own cells, for the report's matrix table and loop bands. The
   * server cannot recover these from `parameters`, which is the row already
   * merged over `## Parameters`.
   */
  dataRowValues?: Record<string, string>;
  /**
   * The test's own frontmatter `dataSources` (name → path), forwarded by the
   * client from the editor buffer. Each path is resolved relative to
   * `testFilePath`'s directory and loaded into a `${<name>.X}` namespace, so
   * test-level named data sources resolve on the server (TestBench) path — not
   * just the CLI parse path. Paths are static (no `${envName}` interpolation).
   */
  dataSources?: Record<string, string>;
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
   * Capture the DOM + URL either side of every step and write the run's
   * recording beside the test when it ends
   * (stories/codebehind-recording-on-disk.md). How a compile's own Record
   * asks for its input; nothing sends it on an ordinary run, and nothing of
   * it is kept on the session. One extra DOM snapshot per step; a cache hit
   * also takes the turn-1 snapshot it would otherwise skip. The only one of
   * compile's run knobs on the wire, because it only records — the ones that
   * change what executes stay in `InternalRunOptions`.
   */
  captureStepContext?: boolean;
  /**
   * Compile the steps this run executes, as it executes them
   * (stories/compile-as-you-go.md).
   *
   * The run is an ordinary run in every other respect — same session, same
   * browser window, same gutter, breakpoints, Pause and Stop all work — and
   * as each step finishes under AI its transcript is queued for generation
   * while the browser moves on. At run end the queue drains and the proposed
   * `.steps.ts` files ride back on `compile:result`. The server never writes
   * them; TestBench applies them through its diff.
   *
   * - `'run'` — **Run & Compile**: the whole test. The Review pass runs over
   *   each touched file at the end, and the recording replaces the test's
   *   previous one wholesale, as a full run's does.
   * - `'steps'` — **Compile This Step**: just the steps sent. Code-behind
   *   execution is disabled for the request, so a step whose entry is broken
   *   runs under AI and produces a fresh transcript rather than being served
   *   (or failed) by the code under repair. No Review — a one-entry diff that
   *   arrives reflowed end to end buries the change the author asked for —
   *   and the recording splices rather than replacing.
   *
   * Either value forces `captureStepContext`: generation needs the DOM either
   * side of the step, and asking a client to remember to send both flags
   * would only mean discovering at Generate time that it did not.
   */
  compile?: 'run' | 'steps';
  /**
   * This request continues a compile already open in this session, rather
   * than starting one (stories/compile-as-you-go.md).
   *
   * A logical run reaches the server as several requests whenever an
   * `[input:]` or `[interactive]` step splits it, or a breakpoint ends one
   * batch and Continue sends the next. Without this the second block would get
   * its own compiler, reading the (unapplied) file from disk again, numbering
   * its steps from 1 and replacing the first block's recording — so the author
   * would silently get a diff for the tail of their test only.
   *
   * Absent means "this is a fresh compile", which also DISCARDS whatever the
   * previous one abandoned: the run that paused at a breakpoint and never
   * resumed, the `[input:]` prompt that was cancelled.
   */
  compileContinues?: boolean;
  /**
   * Attribution for a `compile: 'steps'` request whose steps come from a
   * `### Section` body (stories/compile-as-you-go.md §Compile This Step).
   *
   * EXECUTION is unchanged: the steps still run detached, at the root frame,
   * exactly as Run Step Here runs them — a body step is a runnable unit on its
   * own and this does not make it one that carries a frame. Only the BINDING
   * moves: the generation registry is built against a synthesized section
   * frame of this name, so the entry lands under `section:` in the test's own
   * `.steps.ts`, where the runtime — which reaches that step THROUGH the
   * section — will look for it. Without this the entry binds top-level, never
   * matches, and can shadow a main-flow step of the same text.
   *
   * Only meaningful with `compile: 'steps'`; the step route rejects it
   * otherwise, because a whole-test Run & Compile has the real frames.
   */
  compileScope?: { section: string };
  /**
   * This batch belongs to a compile of this MODE, but asks for no compile of
   * its own (stories/data-driven-rows.md, decision 11).
   *
   * Rows 2..N of a data-driven compile. An entry serves every row, so only the
   * first row carries `compile` — but all of them are one logical run, and the
   * two things the server decides from `compile` are decided per BATCH:
   *
   * - **the AI switch** (stories/run-settings.md §9), which carves out a
   *   compile. Without this, a project with `ai.allowInRuns: false` gave row 1
   *   a diff and failed every later row with "this run forbids AI" — a failure
   *   about the policy, in the middle of the one gesture the policy carves out.
   * - **whether code-behind executes** (`codeBehindOff`), which `'steps'`
   *   turns off so a broken entry re-records under AI. A boolean field bought
   *   the first and lost the second: rows 2..N of a Compile This Step built
   *   the execution registry and ran the very entry row 1 is repairing, which
   *   threw, healed under AI, and painted ⚠ on that step.
   *
   * Opens no compiler, touches no candidate, does not force
   * `captureStepContext`, and writes no proposal. It cannot be retained (it is
   * a per-request field, like `compile`) and it cannot turn a plain run into a
   * compile.
   */
  withinCompileRun?: 'run' | 'steps';
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
   * Inline section definitions from the test file, keyed by `matchText(name)`
   * (stories/test-script-sections-contract.md §2). Required whenever `steps`
   * (or `fullSteps`) may contain bare-name section calls — the server cannot
   * read the file, since the buffer may be unsaved. Line numbers are 1-based
   * in the same document as `sourceLines`. Requires `testFilePath`: section
   * frames and cycle keys derive from it, and api-server answers 400 without
   * it.
   *
   * To be written out identically as `StreamStepsRequest.sections` in
   * runner-core/src/api-client.ts, which lands with the client work — nothing
   * links the two copies, so see the contract §3.2 and change both together.
   *
   * `{}` means absent. Use `hasSections()`, never a bare truthiness check:
   * an empty object is truthy in JS, and treating it as present would put
   * every existing sectionless run onto the expansion path.
   */
  sections?: Record<
    string,
    {
      /** As authored, casing preserved. Display only — the incoming keys are
       *  used verbatim and never re-derived from this. */
      name: string;
      headingLine: number;
      /** Raw line minus `/^\s*\d+\.\s+/`, trimmed, `[no-hooks]` markers
       *  preserved verbatim (the expander strips them when inlining a body).
       *  Empty-after-strip items are culled by the client, so this never
       *  carries a marker-only entry. */
      steps: string[];
      /** Parallel to `steps`. */
      stepLines: number[];
      /** Rows from a table under the `### Name` heading: the section`s body
       *  runs once per row, in the same session (part B). Absent when the
       *  section has no table. */
      rows?: Array<Record<string, string>>;
      /** 1-based position in the AUTHORED table of each row in `rows`, sent
       *  only when the client shipped a subset of them
       *  (stories/data-row-progress-and-selection.md). Both of these travel
       *  together or not at all; the wire validator refuses one alone. */
      rowNumbers?: number[];
      /** The authored table's total row count, so a narrowed loop still
       *  reads `iteration 2 of 3`. */
      rowCount?: number;
      /** 0-based indices into `steps`: run only these body steps, per
       *  iteration, keeping each one's `stepLines` entry and its binding
       *  identity (stories/data-row-progress-and-selection.md, decision 3).
       *  Absent means the whole body, which is every run that predates a
       *  body-narrowing selection. */
      runSteps?: number[];
    }
  >;
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
   * One-shot pause-at-next-code-behind flag (stories/codebehind-debugging.md).
   * Same lifecycle as `pauseAtNextTool`, one seam over: consumed at the next
   * step the loop executes. If that step has a bound code-behind entry, the
   * server emits `codebehind:awaiting-debugger`, parks for the debugger-ack,
   * then runs the entry with a cooperative `debugger;` before its `run()`.
   * A step with no entry consumes the flag silently (F11 degrades to the
   * plain step pause).
   */
  pauseAtNextCodeBehind?: boolean;
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
   * Per-session run settings — the model and the screenshot knobs
   * (stories/run-settings.md §1).
   *
   * Same shape as `logging` above (a per-request override of a server-level
   * setting) with one difference that is the whole point: these are RETAINED.
   * A request carrying settings merges them over the session's; a request
   * carrying none reuses what the session already has. That is what makes a
   * forgotten re-send benign instead of a silent revert to the server default,
   * and it means the preference survives the MCP process restarting.
   *
   * Deliberately NOT part of the write-once `config` block: settings you can
   * only choose when a session is born would mean throwing the browser away to
   * turn capture on mid-debug.
   */
  runSettings?: RunSettings;
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
  /** `'section'` is an inline `### Name` block. `uri` is the file that
   *  defines it and `skillName` carries the section name. */
  kind: 'test' | 'skill' | 'section';
  uri: string;
  line: number;
  skillName?: string;
  /** 1-based iteration of a looped section, and how many there are
   *  (stories/data-driven-rows.md, part B). Absent on every other frame. */
  iteration?: number;
  iterationCount?: number;
}

/**
 * Run-time event the session manager emits per step. The streaming HTTP
 * endpoint converts these to SSE frames; the non-streaming endpoint ignores
 * them.
 *
 * The `frame:*` variants are emitted only when the client asks for skill
 * expansion (via `StepRequest.skillsDir`). Legacy clients can ignore them.
 */
/**
 * Which tab a step actually ran in (stories/mcp-cdp-browser.md §11).
 *
 * Optional and additive: existing consumers validate `line` and `frame` and
 * ignore extra keys, so TestBench, flick and the MCP client are unaffected.
 *
 * `targetId` is the field that matters. Labels are per-session, so two runs
 * sharing one CDP browser both have a `page:2` and only the target id says
 * whether that is the same tab — which is exactly the question an author asks
 * when two parallel tests interfere.
 */
export interface TabInfo {
  label: string;
  targetId: string | null;
  url: string;
  title: string;
  unexpected: boolean;
}

/** One tab an errand opened, as the receipt names it. `targetId` is absent
 *  when the tracker never resolved one (an engine that cannot answer, or a tab
 *  that closed first) — the url + title still identify it for a human. */
export interface ErrandTab {
  targetId?: string;
  url: string;
  title: string;
}

/**
 * What an errand did, carried on its `done` event (stories/errands.md §Return).
 *
 * Declared here beside the rest of the wire protocol, not in `errand-runner`,
 * so the `done` event's type is complete in one place; the errand runner is
 * what fills it in. A session never sets it.
 */
export interface ErrandSummary {
  errandId: string;
  /** The root the errand resolved against, and its scope — echoed from the
   *  request because every result must say which root it used
   *  (stories/mcp-no-project.md §Locked). */
  root: string;
  scope: 'project' | 'user';
  /** Where the borrowed tab ended up. The errand navigates it when a step says
   *  to, and the receipt is the only record of that. */
  finalUrl: string;
  finalTitle: string;
  /** Every tab the errand opened along the way, whether or not it survived. */
  openedTabs: ErrandTab[];
  /** The subset still open on return. Normally the `keepOpen` tabs and nothing
   *  else, because an errand takes its coat when it leaves — but a tab it
   *  opened and no longer holds the wheel of is spared the close and belongs
   *  here too (`ErrandRunner.detach`). */
  keptOpen: ErrandTab[];
}

export type RunEvent =
  | { type: 'step:start'; line: number; frame?: FrameInfo; tab?: TabInfo }
  | {
      type: 'step:pass';
      line: number;
      output?: string;
      /**
       * Why the step never ran — sent only with `output: 'skipped'`, and the
       * same sentence the report row carries. Mirrors `StepPassEvent.reason`
       * in runner-core/src/protocol.ts, where the compatibility rule lives.
       */
      reason?: string;
      /**
       * Which kind of skip — sent only with `output: 'skipped'`.
       * `'unattended'` is an `[input:]` / `[interactive]` step this server
       * would not run with nobody watching; `'not-taken'` is a branch the
       * decision did not choose or a loop body that ran no passes. Absent
       * means `'unattended'`, which is what an older server meant by saying
       * nothing (runner-core/src/protocol.ts, `StepPassEvent.skipKind`).
       */
      skipKind?: 'unattended' | 'not-taken';
      screenshot?: string;
      frame?: FrameInfo;
      fromCache?: boolean;
      tab?: TabInfo;
      /** The step ran its code-behind entry instead of calling the AI
       *  (stories/codebehind-compile.md §What the author sees). Drives the code mark. */
      fromCodeBehind?: boolean;
      /** The entry threw and the step then passed under AI. Drives ⚠ and the
       *  "recompile" prompt; the file is what "Open Code-behind" opens. */
      codeBehindStale?: { file: string; error: string };
      /**
       * Which surface answered this step (SPEC-use-computer.md §4.5, §10.3).
       *
       * Additive, and safe for a client that does not know it: absence means
       * `browser`, which is what every server said by saying nothing. A client
       * that does know can paint a computer-mode step differently — the report
       * does.
       */
      surface?: SessionSurface;
      /**
       * `'mode'` on a `[use …]` row (§10.1) — a step that switched surface and
       * did nothing else: no model call, no page, no tokens. `surface` then
       * names the surface it switched TO, and `output` carries the
       * `→ computer` marker text a client can render as-is.
       */
      stepKind?: 'mode';
    }
  | {
      type: 'step:fail';
      line: number;
      error: string;
      screenshot?: string;
      frame?: FrameInfo;
      tab?: TabInfo;
      /**
       * The step failed and the run CARRIED ON past it — the `otherwise
       * continue` tail (stories/step-failure-outcomes.md, decisions 6 and 9).
       *
       * Additive, and the safe direction for a client that does not know it: it
       * paints ✗ as it always did, while one that does knows not to count this
       * one, not to stop reading, and to paint it amber. Mirrors
       * `StepFailEvent.tolerated` in runner-core/src/protocol.ts.
       */
      tolerated?: boolean;
      /**
       * The author's own words for a tolerated failure — the quoted text of
       * `… otherwise continue with warning "…"`, interpolated and masked. Sent
       * only with `tolerated`.
       *
       * `error` stays the framework's account of what went wrong; this is the
       * only way the author's sentence reaches a client, since the row's
       * explanation does not travel on this event. Mirrors
       * `StepFailEvent.warning`.
       */
      warning?: string;
      /**
       * The author wrote this failure — the `fail` verb (decision 2). `error`
       * is their sentence, so the client says "failed as written" rather than
       * reporting a malfunction, and nothing tries to diagnose it.
       */
      deliberate?: boolean;
      /** `error` is the step's own code-behind failing (a `step.expect`, or
       *  the entry throwing under strict replay) — not an AI-run failure. */
      fromCodeBehind?: boolean;
      /** The entry threw, the step fell through to AI, and the AI attempt
       *  failed too. `error` is the AI failure; this is the crash that put
       *  the step on that path. */
      codeBehindStale?: { file: string; error: string };
      /** Which surface the step was being answered from when it failed
       *  (SPEC-use-computer.md §4.5). Additive; absence means `browser`. */
      surface?: SessionSurface;
      /** `'mode'` when the failing step was a `[use …]` directive — one of
       *  §5.1's four preconditions said no, and `error` is its message. */
      stepKind?: 'mode';
    }
  /**
   * A step that never ran because an earlier step ended the flow it was in
   * (stories/step-flow-control.md, decision 9). Mirrors `StepSkipEvent` in
   * runner-core/src/protocol.ts, which is the client's copy of this contract.
   *
   * One per skipped step line, PLUS one per skipped nested call line — a
   * section or skill invoked inside the returned body, addressed by that
   * frame's `invocationLine` in its parent's file. The call line has no step of
   * its own in the expansion, so without an event it would keep whatever glyph
   * the gutter last painted on it.
   *
   * There is no matching `step:start`, and no `frame:push` for a skipped
   * step's frame. That is the load-bearing part: if the skipped steps went
   * through the frame transitions, a nested call inside the returned body would
   * push, pop clean, and paint ✓ for work that never ran.
   */
  | { type: 'step:skip'; line: number; frame?: FrameInfo; reason: string }
  | { type: 'output'; msg: string; kind: 'info' | 'warn' | 'error' }
  | { type: 'capture'; line: number; name: string; value: string; source: 'capture' | 'toolOutput' | 'assignment' }
  | {
      type: 'done';
      status: 'passed' | 'failed' | 'error' | 'aborted';
      /** Absolute path of the HTML report, when one was written. Always been on
       *  the wire (spread onto the event by the emitter); declared here now
       *  that `effectiveSettings` sits beside it. */
      reportPath?: string;
      /**
       * Steps that passed only because their code-behind entry threw and the
       * step healed under AI, and what those AI turns cost
       * (stories/codebehind-selector-ambiguity.md §"A healed run stops
       * reporting as a clean pass").
       *
       * Absent when nothing healed — a clean run says nothing new — so the
       * run summary line only grows the "1 healed under AI (4.1k tokens)"
       * clause when there is something to report. `status` above is
       * unaffected: a healed run still passed.
       */
      healed?: { steps: number; tokens: number };
      /**
       * What this run actually ran under, and where each value came from
       * (stories/run-settings.md §5).
       *
       * A preference held in a conversation degrades silently — the context is
       * compacted, the flag stops being sent, and you find out when you want a
       * screenshot and there isn't one. Retention prevents the revert; this is
       * what makes the state visible without asking.
       *
       * Optional so an older client is unaffected — and consumers must treat
       * it as absent-able for the mirror-image reason, since an older SERVER
       * omits it entirely.
       */
      effectiveSettings?: EffectiveSettings;
      /**
       * Present only on an errand's `done` (stories/errands.md §Return).
       *
       * It rides this event rather than a separate frame because the MCP side
       * builds the receipt with the same fold that already turns events into
       * `steps[]` + `captures{}` — and because the errand's tabs are only
       * knowable after the detach path has run, which is the last thing that
       * happens before this event.
       */
      errand?: ErrandSummary;
    }
  | { type: 'frame:push'; frame: FrameInfo }
  | { type: 'frame:pop'; frameId: string; outputs: Record<string, string> }
  | {
      type: 'frame:scope';
      frameId: string;
      scope: Record<string, string>;
      /**
       * Which dotted names in `scope` a `For each` pass BOUND there
       * (docs/specs/SPEC-structured-table-reads.md §7.6).
       *
       * `scope` is a copy, and the loop-binding registry is by object
       * identity, so without this the client saw a mixed map with nothing in
       * it saying which half a name came from: `payment.keyword` (a page's
       * column) and `user.apikey` (a data file's own heading) are both
       * `root.property` to a reader. TestBench answered both the narrow way
       * and printed the second in a view sitting beside a report that starred
       * it. With the list, `maskIfSecret` (runner-core) applies the server's
       * two-segment rule to a name that is in it and the flat author rule to
       * one that is not — the same `isSecretParameterName` does.
       *
       * ALWAYS sent, empty list included: an absent field means "an older
       * server, nothing known", which is the no-map fallback, while `[]` is
       * the positive statement that this run has bound nothing — and that is
       * what makes a test with no loop at all mask its `user.apikey`.
       */
      bindings?: string[];
      /**
       * The run's `## Config: unmask:` names — what the author has declared
       * are NOT secrets despite `isSecretName` matching them. Sent only when
       * the list is non-empty, so an ordinary run's payload is unchanged.
       *
       * Exempts an entry from ALL THREE rules on the client, exactly as
       * `formatParameterBlock` (src/ai/prompts.ts) exempts it on the server:
       * masking a declared non-secret by its value or by its record shape
       * would take the hatch away again through another door.
       */
      unmask?: string[];
    }
  | { type: 'step:awaiting'; line: number; frame?: FrameInfo }
  | { type: 'tool:awaiting-debugger'; toolName: string; toolFilePath?: string; line: number; frame?: FrameInfo }
  | { type: 'codebehind:awaiting-debugger'; file: string; line: number; frame?: FrameInfo }
  /**
   * A compile-mode run's own frames (stories/compile-as-you-go.md §On the
   * wire). Shaped like the compile stream's so a client's folding carries
   * over; emitted only when the request carried `compile`.
   *
   * `compile:step` — an entry was generated, declined or could not be
   * generated for a step, with the step's line for the gutter. `step: 0` is
   * the Review pass, which belongs to the file rather than to any step.
   */
  | {
      type: 'compile:step';
      phase: CompilePhase;
      step: number;
      line?: number;
      message: string;
    }
  /**
   * How far the compile tail has got, as numbers
   * (stories/compile-tail-progress.md). Its own frame so a client never has to
   * parse the prose on `compile:step` to draw a progress bar.
   */
  | {
      type: 'compile:progress';
      done: number;
      total: number;
      phase: 'generate' | 'review';
      step?: number;
      line?: number;
      reviewPending?: boolean;
      runEnded?: boolean;
    }
  /**
   * Terminal for the compile, after the queue drains and Review runs, and
   * before `done`. Proposals only: the server writes no `.steps.ts` on this
   * path.
   */
  | {
      type: 'compile:result';
      status: CompileStatus;
      files: Record<string, string>;
      summary: CompileSummary;
    };

export type RunEventListener = (event: RunEvent) => void;

/**
 * What one server-driven run left behind, beyond the folded `StepResponse`.
 *
 * The HTTP response deliberately reduces each step to `StepResultResponse`;
 * the compiler needs the whole thing — turns, DOM either side, assertions — so
 * an in-process caller can ask for it. Never serialized.
 */
export interface RunDetails {
  /** Full per-step records, in execution order. */
  steps: StepResult[];
  /** The run's final parameter map, captures included. */
  parameters: Record<string, string>;
  tokens: number;
}

/**
 * Knobs no HTTP client can set (stories/codebehind-compile.md §Server).
 *
 * The compile endpoint drives this same session machinery in-process, and
 * needs three things from a run that no test author ever asks for. They are
 * kept off `StepRequest` on purpose: that type is the wire, and a field there
 * is a field the world can set. (A fourth, capturing step context, only
 * retains more and went on the wire — `StepRequest.captureStepContext`.)
 */
export interface InternalRunOptions {
  codeBehind?: {
    /**
     * The expansion the caller has already computed — used to build the
     * code-behind registry instead of the server's own re-expansion.
     *
     * Compile sends its steps pre-expanded (no `skillsDir`), so the server has
     * no frames of its own to bind through; without this every skill-body step
     * would bind into the *test's* `.steps.ts` rather than the skill's.
     */
    expansion?: {
      steps: string[];
      rawSteps: string[];
      origins: ExpandedStepOrigin[];
      frames: Record<string, ExpandedFrame>;
    };
    /** Canonical `.steps.ts` path → the path to load instead (replay). */
    candidateFiles?: Record<string, string>;
    /** Ignore every entry, so all steps run under AI (record). */
    disabled?: boolean;
    /** An entry that throws fails the step instead of healing under AI. */
    strict?: boolean;
  };
  /** Receives the full step records the `StepResponse` folds away. */
  onRunDetails?: (details: RunDetails) => void;
  /**
   * Ignore the AI run switch for this request (stories/run-settings.md §9).
   *
   * Compile, Repair This Step and errands are requests *for* AI, so a session
   * whose retained `ai` is `off` must not gate its own repairs. Deliberately
   * here and not on `StepRequest`: sending `runSettings: {ai: "on"}` instead
   * would be RETAINED by `mergeRunSettings` and silently clobber the caller's
   * standing `off` for every later run.
   */
  bypassAiPolicy?: boolean;
}

export interface StepResultResponse {
  step: string;
  /**
   * `'skipped'` is additive (stories/step-flow-control.md, decision 9): the
   * step did not run because an earlier one ended the flow it was in, and
   * `reasoning` says which step and which flow. Reporting it `passed` would
   * be a green row for work that never happened.
   */
  status: 'passed' | 'failed' | 'error' | 'skipped';
  actions: unknown[];
  screenshot: string;
  reasoning: string;
  outputs: Record<string, string>;
  /**
   * True when this row failed and the run continued past it — the `otherwise
   * continue` tail (stories/step-failure-outcomes.md, decision 9).
   *
   * `status` deliberately stays `'failed'`: the step did not do what it said,
   * and widening the status union would change the meaning of a value every
   * existing reader already switches on. This flag is how an API reader tells the
   * two apart; `done.status` already excludes a tolerated failure (decision 6).
   *
   * Additive — omitted for every other row.
   */
  tolerated?: boolean;
  /**
   * The author's warning on a tolerated row — the quoted text of
   * `… otherwise continue with warning "…"`, interpolated and masked.
   *
   * `reasoning` holds the same sentence folded into the step's explanation, but a
   * reader that wants only the author's words should not have to parse prose to
   * find them, and every other surface carries the warning as its own field.
   * Additive, and absent whenever no warning was written.
   */
  warning?: string;
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
  outputSources: Record<string, 'parameter' | 'capture' | 'toolOutput' | 'assignment'>;
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
  /** The CDP browser this session is driving, or null for an ordinary
   *  disposable one. `profile` is the label the caller sent — descriptive
   *  only, since `port` is what selected the browser — and is null when the
   *  caller addressed it by port and named no profile. */
  cdp: { port: number; profile: string | null } | null;
  /**
   * The tab this session is currently on (stories/cdp-tabs.md §4).
   *
   * Answers "which session is driving my cart tab?" without digging through a
   * previous run's step results. Set for launch-mode sessions too — target ids
   * are cached in both modes — so the field means "the tab", not "the CDP tab".
   * No title: see `PageTracker.activeTabRef`.
   */
  tab: { targetId: string | null; url: string } | null;
}

/**
 * The tab → session join for one CDP browser, and whether it is the whole
 * truth.
 *
 * `complete: false` means at least one session's tabs could not be enumerated
 * in time. For the listing that is cosmetic; for the close guard it is the
 * difference between "no session holds this tab" and "I could not find out",
 * and only the first may permit a close.
 */
export interface SessionsByTarget {
  byTarget: Map<string, string>;
  complete: boolean;
}

/** One session driving one tab, and whether it is doing anything with it right
 *  now. `executing` means a batch is in flight. */
export interface SessionTabHolder {
  sessionId: string;
  status: 'active' | 'executing';
}

/**
 * The same join as `SessionsByTarget`, carrying **every** holder of each tab
 * with its status (stories/errands.md §The wheel).
 *
 * Both extensions are load-bearing for the errand guard and neither is
 * cosmetic. Two sessions can legitimately hold one tab, and `SessionsByTarget`
 * keeps only the first to answer — so an idle winner would mask a session
 * mid-batch, and the errand would borrow a wheel someone else is turning.
 * Filtering `SessionsByTarget`'s output cannot recover either fact.
 */
export interface SessionsHoldingTargets {
  byTarget: Map<string, SessionTabHolder[]>;
  complete: boolean;
}

/** The page as read by a SESSION: the capture, plus the two facts only a
 *  session has. */
export interface PageContent extends CapturedPageContent {
  sessionId: string;
  /** `executing` means a run is in flight and the page may move underneath
   *  the caller — the read is deliberately not queued behind it. */
  status: 'active' | 'executing';
}

/** Run token totals — a frozen snapshot of the per-run tracker getters. */
export interface RunTokens {
  total: number;
  input: number;
  output: number;
}

/**
 * Delivered via `GET /sessions/:id/last-run` so a client that stopped a run can
 * recover the report path + token totals the dropped `done` event would have
 * carried (issue 021). `finalized` is the poll signal; `reportPath` is absent
 * when no report was written.
 */
export interface LastRunInfo {
  finalized: boolean;
  tokens: RunTokens;
  reportPath?: string;
}

/**
 * Answer to "what settings are in force?" — delivered via `GET /config`
 * (stories/run-settings.md §6).
 *
 * Both halves, because either alone misleads: the server base alone hides an
 * override the agent set two turns ago, and the session's effective values alone
 * give nothing to compare them against, so "is this a default or did someone
 * change it?" stays unanswered.
 */
export interface RunSettingsReport {
  /** What a run with no project config and no overrides would use. */
  server: EffectiveSettings;
  /** Present only when a session was named. */
  session: {
    sessionId: string;
    /** Retained overrides, exactly as they stand — the empty object when the
     *  session has never been given any. */
    overrides: RunSettings;
    effective: EffectiveSettings;
  } | null;
}

// ---------------------------------------------------------------------------
// Internal session data
// ---------------------------------------------------------------------------

/**
 * Bound on any single page read taken while listing sessions.
 *
 * `GET /sessions` has no deadline of its own, and both reads it performs —
 * `page.title()` and the target-id lookup — can hang on a wedged page. Sized
 * well under `list_sessions`'s own 5 s abort so the caller gets a listing with
 * a blank field rather than a timeout with nothing in it.
 */
const PAGE_READ_TIMEOUT_MS = 1_500;

/** `SessionListItem.cdp` for one session. Reads the retained `sessionConfig`
 *  rather than probing anything — the binding was decided when the session was
 *  created and cannot change afterwards. */
function cdpBinding(session: ManagedSession): SessionListItem['cdp'] {
  const cdp = session.sessionConfig.cdp;
  if (cdp === undefined) return null;
  return { port: cdp.port, profile: cdp.profile ?? null };
}

/**
 * A compile riding this session's run, held open across the run's blocks
 * (stories/compile-as-you-go.md).
 *
 * A logical run is several HTTP requests whenever an `[input:]`,
 * `[interactive]` or breakpoint splits it. Everything the compile accumulates
 * — the candidate, the step numbering, the recording — belongs to the run, not
 * to the block, so it lives here rather than in `executeStepsInternal`'s
 * locals.
 */
interface OpenCompile {
  compiler: LiveCompiler;
  /** `compileLockKey` of the test, so a request for a different file cannot
   *  continue this one by accident. */
  key: string;
  testFilePath: string;
  /** Every block's step results, renumbered into the run's own index space.
   *  The recording is written from these, so a later block cannot wipe an
   *  earlier one's. */
  steps: StepResult[];
  /** Splice identities by run-global 1-based step index. */
  identities: Record<
    number,
    {
      source: string;
      section?: string | undefined;
      occurrence?: number | undefined;
      file?: string | undefined;
    }
  >;
  /** When the first block started — the recording's `startedAt`. */
  startedAt: string;
  /** True once any block of this run failed, for the recording's status. */
  anyFailed: boolean;
}

/**
 * The surface a session's steps are answered from
 * (SPEC-use-computer.md §4.5).
 *
 * Exported because it is the one piece of this state other layers need to
 * name: the `[use computer]` / `[use browser]` directive sets it, the step
 * boundary reads it to decide whether to launch a browser, and the report
 * marks the steps that ran off-page with it.
 */
export type SessionSurface = 'browser' | 'computer';

/**
 * The computer surface's injectable seams (SPEC-use-computer.md §5.1, §5.9).
 *
 * Three things a unit test must be able to replace, and one reason for all
 * three: none of them may touch the real machine. `loadDesktopAdapter` keeps
 * nut.js out of the test process entirely — the same laziness §5.1 item 2
 * requires of production, for the same reason — and `computerLock` keeps the
 * lock file out of `os.tmpdir()`, where a stray one would break the NEXT
 * computer-mode run on the developer's own machine.
 */
export interface SessionManagerDeps {
  loadDesktopAdapter?: () => Promise<DesktopAdapter>;
  probeComputerCapture?: (adapter: DesktopAdapter) => Promise<void>;
  computerLock?: ComputerLockOptions;
  /** §5.1 item 1b / §15.4 — the vision-route check, so a test never reaches
   *  the network. Defaults to `checkVisionRoute` (src/desktop/vision-route.ts). */
  checkVisionRoute?: (ai: VisionRouteAi) => Promise<VisionRouteResult>;
}

/**
 * The session's surface fields, as the shared state machine reads and writes
 * them (`SurfaceState`, src/runner/computer-step.ts).
 *
 * Accessors over the live session rather than a copy, and that is the whole
 * point: `session.surface` stays the one authoritative field — the launch gate
 * reads it, `getSession` reports it, the tests assert on it — while
 * `enterComputerMode` / `leaveComputerMode` get something to write to. A
 * snapshot object would have made the transition invisible to the gate two
 * lines later.
 */
function surfaceStateOf(session: {
  surface: SessionSurface;
  computerAdapter?: DesktopAdapter | undefined;
}): SurfaceState {
  return {
    get surface() { return session.surface; },
    set surface(value) { session.surface = value; },
    get adapter() { return session.computerAdapter; },
    set adapter(value) { session.computerAdapter = value; },
  };
}

interface ManagedSession {
  id: string;
  /** The compile riding this session's run, when one is open. */
  liveCompile?: OpenCompile | undefined;
  /** Snapshot of the currently-active browser. Refreshed from `browserTracker`
   *  after every step so subsequent steps target whatever openBrowser /
   *  switchBrowser / closeBrowser left as active.
   *
   *  `undefined` until the browser launches. The launch moved out of session
   *  creation and onto the first step that runs while `surface` is `browser`
   *  (SPEC-use-computer.md §4.6), so a session created for a test whose first
   *  step is `[use computer]` holds none — and the out-of-band readers
   *  (`getPageContent`, `activePageFor`, the listings) must answer that rather
   *  than launch one. */
  browserSession: BrowserSession | undefined;
  /** Owns every browser launched in this session — the initial one plus any
   *  added by `openBrowser`. Closing the session calls `closeAll()` so no
   *  named browser leaks. */
  browserTracker: BrowserTracker;
  /** The MAIN page captured at the browser launch — needed to read its
   *  `video()` handle at closeSession time, since the active page may have
   *  shifted via openBrowser/switchBrowser. Tier 1 records the main page only.
   *
   *  `undefined` until the browser launches (§4.6); `finalizeMainPageVideo`
   *  takes it optional for exactly that reason. */
  mainPage: Page | undefined;
  /**
   * Which surface the next step is answered from (SPEC-use-computer.md §4.5):
   * `browser` = DOM snapshot + Playwright, `computer` = a screenshot of the
   * whole screen driven through nut.js.
   *
   * Session state, not file state: TestBench posts steps one request at a
   * time, so `[use computer]` in step 1 of a file is a fact about the session
   * from then on, not something the server could read off the document.
   *
   * Two things read it: the step boundary calls `ensureLaunched()` when, and
   * only when, this says `browser` (§4.6), and the step dispatch sends a prose
   * step to `executeComputerStep` when it says `computer` (§5.5).
   */
  surface: SessionSurface;
  /**
   * The desktop adapter this session loaded at its `[use computer]` step
   * (SPEC-use-computer.md §5.1 item 2), for as long as it is on that surface.
   *
   * On the SESSION rather than on the run, for the reason `surface` is:
   * TestBench posts steps one batch at a time, so a run that entered computer
   * mode in batch 1 must still be on it — same adapter, same held lock — when
   * batch 2 arrives. Dropped on the way back to `browser`, and at
   * `closeSession`, which is also where the lock is released.
   */
  computerAdapter?: DesktopAdapter | undefined;
  /** Resolved video-recording mode for this session (from the test's project
   *  `browser.video`). */
  videoMode: VideoMode;
  /** Absolute, project-anchored report output dir
   *  (`<projectRoot>/<reports.outputDir>`, or the server's startup outputDir
   *  when no project root resolves). Reports, the per-run log, and `videoDir`
   *  are all anchored here so they land in the TEST's project — not the
   *  server's cwd — matching the CLI runner. */
  reportOutputDir: string;
  /** Absolute `<reportOutputDir>/videos` directory the .webm records into. */
  videoDir: string;
  /**
   * Set at run-end report assembly when video recording is active. Because a
   * server session is REUSABLE (the browser context is NOT closed at run end —
   * only at closeSession), the .webm can't be finalised yet (`saveAs` would
   * hang waiting for the page to close). So we retain the assembled report +
   * its path here and finalise the video — then re-render the report with
   * `videoRelPath` set — when the session is later closed. Last run wins.
   */
  pendingVideo?: {
    /** The assembled report, re-rendered with `videoRelPath` once the .webm
     *  is finalised. */
    report: TestReport;
    /** Absolute path of the already-written report HTML (overwritten in
     *  place). Empty for a data-driven row, which wrote no report of its own —
     *  the saved path is written onto `report` instead, and the accumulator
     *  holds that same object. */
    reportPath: string;
    /** Run outcome — drives retain-on-failure deletion. */
    passed: boolean;
    /** 0-based row index when this run was one row of a data-driven run. Keeps
     *  the `.webm` names apart: a merged report has one video per row and only
     *  one report name to derive them from. */
    dataRowIndex?: number;
  };
  status: 'active' | 'executing' | 'closed';
  /**
   * Browser settings from the project bundle of the most recent step batch,
   * retained so an out-of-band page read uses the dom-cleaner options of the
   * PROJECT this session last ran against.
   *
   * Note this is not the same as what the runner uses: `executeStep` is handed
   * `this.config` (the server's startup config), so a step currently cleans
   * with the server's options while a read cleans with the project's. The read
   * side is the correct one — a session created for project A should be read
   * with project A's settings — and bringing the runner into line means
   * threading `projectConfig` into `executeStep`, which is a separate change
   * with its own blast radius.
   *
   * Retained rather than re-resolved because the bundle is keyed on a test
   * file path (`resolveProjectBundle`), and a content read has no test file —
   * only a session id. Seeded from the server's startup config so a session
   * created but never run is still readable; overwritten with the project's
   * values on the first batch.
   *
   * Reading `this.config.browser` here instead would silently apply the
   * SERVER's cleaner settings to every project but its own.
   */
  browserConfig: Config['browser'];
  /**
   * THIS project's `desktop` section, retained for the same reason
   * `browserConfig` is and fixing a measured defect: `[use computer]` and the
   * computer step's §5.10 values used to be read off `runConfig`, which
   * `resolveRunSettings` rebuilds from the SERVER's startup config — so a
   * project whose `aiui.config.json` said `desktop.enabled: true` was refused
   * by a server whose own config said nothing.
   *
   * Seeded from the server's startup config (which carries the `enabled:
   * false` default) so a session that never runs a batch — and a request with
   * no `testFilePath`, whose bundle IS the server's config — behaves exactly
   * as it did before. Overwritten with the project's values on the first
   * batch, beside `browserConfig`.
   */
  desktopConfig: Config['desktop'];
  /** `cdp` is retained, not just consumed at launch: without it `list_sessions`
   *  cannot say which session is driving a persistent signed-in browser, and
   *  the answer is unrecoverable afterwards. It was always assigned here — the
   *  old type simply hid it. */
  sessionConfig: {
    baseUrl?: string;
    timeout?: string;
    /** The RAW spec (`mobile`, `390x844`), retained for the same reason `cdp`
     *  is: the resolved size is inside the browser and unrecoverable from
     *  here, and a listing that could not say what a session was launched at
     *  would leave the one thing this feature exists to make visible invisible
     *  (stories/per-test-viewport.md §3). */
    viewport?: string;
    cdp?: { port: number; tab?: string; profile?: string };
  };
  configSet: boolean;
  /**
   * Retained run-setting overrides (stories/run-settings.md §2). Seeded empty;
   * each batch that carries `runSettings` merges over this, and each batch that
   * carries none reuses it.
   *
   * Session-scoped and never process-wide: the same server also serves
   * TestBench, and a global setting would let an agent's choice change the cost
   * and speed of a human's concurrent run.
   */
  runSettings: RunSettings;
  /**
   * What the LAST batch resolved, retained so `GET /config?sessionId=` can
   * answer without a test file to re-resolve a project bundle from — the same
   * problem, and the same answer, as `browserConfig` above. Absent until the
   * session has run once.
   */
  lastEffectiveSettings?: EffectiveSettings;
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
  outputSources: Record<string, 'parameter' | 'capture' | 'toolOutput' | 'assignment'>;
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
  /**
   * One-shot sibling of `pauseAtNextTool` for code-behind entries
   * (stories/codebehind-debugging.md). Consumed — unconditionally — at the
   * next step the loop executes, so an F11 can never ambush a later step;
   * it only produces a pause when that step's binding has an entry.
   */
  pauseAtNextCodeBehind: boolean;
  /**
   * Dead-section warning messages this session has already emitted.
   *
   * The warning is a DOCUMENT diagnostic, but the server sees batches — a run
   * may arrive as one or as several (a breakpoint split, an `[input:]` split,
   * a resume) and nothing in the request says which. Deduping on the message
   * sidesteps the question entirely: it names the file, the section and the
   * line, so it repeats exactly when the same thing is still true and changes
   * the moment it isn't.
   *
   * Two attempts to infer "first batch of a run" from the request shape are
   * why this is keyed the way it is. A positional check
   * (`steps[0] === fullSteps[0]`) lost the warning for every run whose first
   * batch starts mid-document, which is any test opening with an `[input:]`
   * step. A document-shape key could not see skill files, so a section a
   * skill edit had just orphaned went unreported for the rest of the session.
   */
  deadSectionsReported: Set<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True iff this request carries usable section definitions.
 *
 * `{}` is truthy in JS, so a bare `request.sections` check would flip every
 * sectionless run onto the expansion path — a behaviour change for every
 * existing client. Contract §3.2: four gates must use this predicate.
 */
export function hasSections(request: {
  sections?: Record<string, unknown> | undefined;
}): boolean {
  return !!request.sections && Object.keys(request.sections).length > 0;
}

/**
 * Walk the frame chain rooted at `frameId` and return the name of the
 * outermost **section** frame that sits OUTSIDE any skill frame.
 *
 * The frame-based twin of the expander's `sourceSections` rule. A skill's own
 * internal sections are private to it, so they are never the answer: for
 * `test → section A → skill S → section B`, a step in B reports "A", because
 * B is skill-private while A is what the test author actually wrote. Only a
 * skill invoked directly from the root flow yields undefined.
 *
 * That skip is what keeps the documented both-badges case true — one step can
 * carry skill S and section A at once, which is why this is a separate walk
 * from `outermostSkillName` rather than the same walk with the kind swapped.
 */
/**
 * The `loop` marker for a step, derived from the nearest enclosing frame that
 * is an iteration of a looped section (stories/data-driven-rows.md, part B).
 *
 * INNERMOST wins, unlike `outermostSectionName` above. The marker exists to
 * say where the step's values came from, and inside nested loops that is the
 * inner row; the enclosing ones stay legible on the frames themselves, which
 * is where the Call Stack already reads them.
 */
function loopMarkerFor(
  frameId: string | undefined,
  frames: Record<string, FrameInfo> | null,
  // The wire FrameInfo deliberately carries no `inputs` — they are kept in a
  // parallel server-side map — so the row values come in separately.
  inputsByFrame: Record<string, Record<string, string>>,
  // The LIVE variable map, only so the marker's values can be told whose
  // names they are. `applyPassBindings` marks a pass's dotted bindings there
  // and the registry is by object identity, so the frame-inputs copy this
  // builds from — itself a copy, made in `cloneFramesForPass` — arrives with
  // none of them, and `redactReport` would decide `payment.keyword` by the
  // author rule and mask `AU` (§7.6, the round-2 defect).
  boundIn?: object,
): LoopMarker | undefined {
  if (!frameId || !frames) return undefined;
  const seen = new Set<string>();
  let current: FrameInfo | undefined = frames[frameId];
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    // `iterationCount` is deliberately NOT required: a runtime loop
    // (`While …`, `Repeat … until …`) pushes its frames mid-loop with no total
    // to give, and the count is back-filled when the loop ends
    // (stories/control-flow.md). Requiring it here would have made every such
    // frame read as unlooped and dropped the band from the report entirely.
    if (current.iteration !== undefined) {
      const values = { ...(inputsByFrame[current.id] ?? {}) };
      if (boundIn) inheritLoopBindings(boundIn, values);
      return {
        kind: 'iteration',
        ...(current.skillName && { label: current.skillName }),
        index: current.iteration,
        ...(current.iterationCount !== undefined && { count: current.iterationCount }),
        values,
      };
    }
    current = current.parentId ? frames[current.parentId] : undefined;
  }
  return undefined;
}

/**
 * The parameter snapshot the live compile is handed — a copy, because the run
 * keeps writing to its own map, with the loop marks carried onto it.
 *
 * The copy is the point and the hazard at once. The registry is by object
 * identity, so the snapshot arrives as nobody's binding, and the compile's
 * prompts — which now ask the map whose a dotted name is (§7.6) — would read
 * every `payment.keyword` by the author rule and mask `AU` out of the block
 * the model writes its selector from. One line at the copy, exactly as
 * `secretsNow` does for its merge.
 *
 * Exported for tests/codebehind-live-compile.test.ts, which pins both halves
 * of that: what this function answers, and that both `liveCompile.offer`
 * call sites go through it rather than spreading the map themselves.
 */
export function liveCompileSnapshot(resolvedParameters: Record<string, string>): Record<string, string> {
  const snapshot = { ...resolvedParameters };
  inheritLoopBindings(resolvedParameters, snapshot);
  return snapshot;
}

function outermostSectionName(
  frameId: string | undefined,
  frames: Record<string, FrameInfo> | null,
): string | undefined {
  if (!frameId || !frames) return undefined;

  // Collect the ancestry leaf-to-root, then read it root-first. Scanning
  // outward-in is what makes "outermost, but only outside every skill" a
  // single pass with no flags: the first section wins, and a skill
  // encountered first ends the search because everything below it is that
  // skill's private business.
  const chain: FrameInfo[] = [];
  const seen = new Set<string>();
  let current: FrameInfo | undefined = frames[frameId];
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentId ? frames[current.parentId] : undefined;
  }

  for (let i = chain.length - 1; i >= 0; i--) {
    const frame = chain[i]!;
    if (frame.kind === 'skill') return undefined;
    if (frame.kind === 'section') return frame.skillName;
  }
  return undefined;
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

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private config: Config;

  /**
   * The Map key for a session id.
   *
   * TestBench's session ids ARE file paths — `uri.fsPath`, which lower-cases
   * the drive letter (batch runs append `::run-N`) — while a CLI, MCP or test
   * caller spells the same file with an uppercase drive. Windows paths are
   * case-insensitive, so on win32 two spellings of one file must be one
   * session: without this, `DELETE /sessions/:id` from the other spelling
   * no-ops and the browser is left behind (observed 2026-08-25 in live-test
   * cleanup). The same normalisation `compileLockKey` applies, gated the same
   * way, but only for ids that LOOK like Windows paths (drive-letter or UNC
   * prefix) — `compile:<uuid>` and arbitrary names stay case-sensitive.
   *
   * Every `sessions` / `lastRunInfo` access goes through here; `session.id`
   * keeps the spelling the session was created with, for logs and events.
   */
  private sessionKey(sessionId: string): string {
    return process.platform === 'win32' && /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(sessionId)
      ? sessionId.toLowerCase()
      : sessionId;
  }

  /** Backing store for `runsInFlight()`. See `executeSteps`. */
  private activeRuns = 0;

  /**
   * Last finalized run per session id — the channel for delivering a report path
   * + token totals to a client that *stopped* the run (issue 021). A stop closes
   * the SSE stream before the final `done` event, so `reportPath`/tokens are
   * dropped in transit; the client re-fetches them here via
   * `GET /sessions/:id/last-run`. Kept on the manager (not the session) so it
   * survives a browser-closing stop that deletes the session. `reportPath` is
   * absent when report generation produced nothing (0 steps that could render or
   * a generation failure); `finalized` flips true once the run's post-loop
   * finalize has run, so the client polls until then rather than guessing a
   * timeout. Tokens are a FROZEN snapshot taken when the report was built — never
   * recompute live, or a reused session's next `markRunStart` would zero it.
   */
  private lastRunInfo = new Map<string, LastRunInfo>();

  /**
   * Rows of a data-driven run, accumulating across the batches that ran them
   * (stories/data-driven-rows.md, decision 12: one run, one report).
   *
   * On the manager rather than on `ManagedSession` for the same reason
   * `lastRunInfo` is: the client closes the session at every row boundary, so
   * anything held on the session dies with row 1. Bounded the same way, and
   * cleared by the finalise route.
   */
  private rowRuns = new Map<string, RowRunAccumulator>();

  constructor(
    config: Config,
    /** Injectable so the errand runner beside this manager resolves — and
     *  caches — projects through the same instance. Defaulted so every existing
     *  caller keeps working unchanged. */
    private readonly projectBundles = new ProjectBundleResolver(config),
    /** The computer surface's seams (SPEC-use-computer.md §5.1, §5.9).
     *  Defaulted, so the only caller that passes anything is a test. */
    private readonly deps: SessionManagerDeps = {},
  ) {
    this.config = config;
  }

  /** §5.1 item 2, with the default. */
  private get loadDesktopAdapter(): () => Promise<DesktopAdapter> {
    return this.deps.loadDesktopAdapter ?? defaultLoadDesktopAdapter;
  }

  /** §5.1 item 4, with the default. */
  private get probeComputerCapture(): (adapter: DesktopAdapter) => Promise<void> {
    return this.deps.probeComputerCapture ?? defaultProbeComputerCapture;
  }

  /**
   * Count work this manager does not own as a run in flight, and hand back the
   * release.
   *
   * The one thing an errand borrows from the session world (stories/errands.md
   * §What already exists vs what is new): `/health`, the `POST /admin/shutdown`
   * 409 and the idle reaper all read `runsInFlight()`, and an errand IS a run —
   * a server that reaped itself mid-errand would kill work a user is watching.
   *
   * The returned release is idempotent and MUST be called in a `finally`: a
   * stranded increment disables the idle timeout for the rest of the process's
   * life and makes every later `aiui stop` answer 409.
   */
  beginExternalRun(): () => void {
    this.activeRuns++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRuns--;
    };
  }

  /**
   * Resolve the per-project recording outputs for a NEW session from the test
   * file's own project config: the video-record mode (`browser.video`) and the
   * absolute report output dir (`<projectRoot>/<reports.outputDir>`). Both are
   * fixed at session creation — the recording context is launched, and
   * videoDir/report dir set, before the per-batch bundle resolves — so they
   * must come from the project config HERE, not the server startup config.
   * Anchoring the output dir to the project root makes reports + videos + the
   * run log land in the TEST's project, matching the CLI runner. A session maps
   * to one test file, so a reused session keeps the right dir. Other browser
   * settings (headed, stealth, …) intentionally stay server-global. Any failure
   * (malformed/absent project config) falls back to the server startup config's
   * outputDir; the malformed config then surfaces when the batch re-resolves the
   * bundle.
   */
  private async resolveSessionOutput(
    request: StepRequest,
  ): Promise<{ videoMode: VideoMode; reportOutputDir: string }> {
    try {
      if (request.testFilePath) {
        const envName = request.envName?.trim() || null;
        const bundle = await this.resolveProjectBundle(request.testFilePath, envName);
        const reportOutputDir = bundle.projectRoot
          ? pathResolve(bundle.projectRoot, bundle.config.reports.outputDir)
          : pathResolve(this.config.reports.outputDir);
        return { videoMode: resolveVideoMode(bundle.config.browser.video), reportOutputDir };
      }
    } catch (err) {
      logger.warn(
        `Could not resolve per-project recording output (${(err as Error).message}); ` +
          `falling back to server default`,
      );
    }
    return {
      videoMode: resolveVideoMode(this.config.browser.video),
      reportOutputDir: pathResolve(this.config.reports.outputDir),
    };
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
    return this.projectBundles.resolve(testFilePath, envName);
  }

  /**
   * Resolve a pending run-control wait for `sessionId` with the supplied
   * mode. Called by the HTTP `POST /sessions/:id/run-control` handler.
   * Returns `true` if a paused run actually picked the mode up, `false`
   * if there was no paused run to deliver to (so the handler can return a
   * 409 / "no pause" diagnostic).
   */
  submitRunControl(sessionId: string, mode: 'continue' | 'into' | 'over' | 'out'): boolean {
    const session = this.sessions.get(this.sessionKey(sessionId));
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
    const session = this.sessions.get(this.sessionKey(sessionId));
    if (!session) return false;
    session.pauseAtNextTool = value;
    return true;
  }

  /**
   * Sibling of `setPauseAtNextTool` for code-behind step-into
   * (stories/codebehind-debugging.md) — the run-control endpoint sets it
   * only after the control was actually delivered, for the same
   * no-stuck-flag reason.
   */
  setPauseAtNextCodeBehind(sessionId: string, value: boolean): boolean {
    const session = this.sessions.get(this.sessionKey(sessionId));
    if (!session) return false;
    session.pauseAtNextCodeBehind = value;
    return true;
  }

  /**
   * Resolve the per-session debugger-ack wait. Returns `true` if a run
   * was actually parked on the ack (so the HTTP handler can 200), `false`
   * if no run is awaiting (handler returns 409).
   */
  submitDebuggerAck(sessionId: string): boolean {
    const session = this.sessions.get(this.sessionKey(sessionId));
    if (!session?.pendingDebuggerAck) return false;
    const { resolve } = session.pendingDebuggerAck;
    session.pendingDebuggerAck = null;
    resolve();
    return true;
  }

  /**
   * Park the step loop on the per-session debugger-ack promise, after an
   * `*:awaiting-debugger` event has been emitted. Shared by the tool and
   * code-behind pause points so their abort semantics cannot diverge.
   *
   * Returns `true` when the ack actually arrived — the only case where the
   * caller may arm its cooperative `debugger;`. If the run is aborted while
   * parked, resolves immediately (so the next-iteration abort check picks it
   * up) and returns `false`: there is no debugger attached on that path, and
   * hitting `debugger;` anyway would pause nothing for no one.
   */
  private async awaitDebuggerAck(
    session: ManagedSession,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
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
    return !abortedDuringWait;
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
    /** In-process only — see `InternalRunOptions`. */
    internal?: InternalRunOptions,
  ): Promise<StepResponse> {
    // `runsInFlight` pins the idle-shutdown timer (story server-lifecycle §3).
    // Incremented at the very entry of a run — before session creation and
    // before the per-session queue — so every phase counts, including setup
    // and a run queued behind another. Decremented in a `finally` so a throw
    // or an abort can never strand the counter above zero, which would
    // silently disable the idle timeout for the rest of the process's life.
    this.activeRuns++;
    // One compile per test file at a time, whichever route asked — shared
    // with `POST /codebehind/compile` (stories/compile-as-you-go.md §On the
    // wire). The step route asks `compileLock.isLocked` itself before opening
    // the stream so the ordinary case is a 409; this is the race the route
    // cannot see, and it arrives as an error frame.
    const releaseCompile =
      request.compile !== undefined && request.testFilePath !== undefined
        ? compileLock.acquire(request.testFilePath)
        : (): void => {};
    if (!releaseCompile) {
      this.activeRuns--;
      throw new Error(
        `A compile of ${basename(request.testFilePath!)} is already running. ` +
          'One compile per test file at a time.',
      );
    }
    try {
      return await this.executeStepsUncounted(sessionId, request, onEvent, signal, internal);
    } finally {
      releaseCompile();
      this.activeRuns--;
    }
  }

  /**
   * Number of runs currently in flight (setup, queued, or executing).
   *
   * A maintained counter rather than a scan of per-session state, so
   * `GET /health` stays a cheap synchronous read. Step-mode and
   * tool-debugger pauses park *inside* the run, so a paused run still
   * counts — which is what stops the idle reaper from killing a server the
   * user is actively stepping through. The extension's *breakpoint* pause is
   * client-side (the batch is truncated and the run completes), so it is
   * invisible here by design and is covered by the extension's keep-alive.
   */
  runsInFlight(): number {
    return this.activeRuns;
  }

  /**
   * Count of non-closed sessions.
   *
   * Separate from `getActiveSessions()` because that one reaches into each
   * session's Playwright page (`page.url()`) and allocates a
   * `SessionListItem` per session — fine for `GET /sessions`, wrong for
   * `GET /health`, which is polled every 30 s per client and is supposed to
   * touch no session state beyond counts.
   */
  countOpenSessions(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.status !== 'closed') count++;
    }
    return count;
  }

  private async executeStepsUncounted(
    sessionId: string,
    request: StepRequest,
    onEvent?: RunEventListener,
    signal?: AbortSignal,
    internal?: InternalRunOptions,
  ): Promise<StepResponse> {
    // Clear the module-level skill cache at the start of every request so
    // disk edits to skill files between batches are picked up. The API
    // server is long-lived; without this an edit during a paused run stays
    // masked by the earlier-cached parse. Within a single request the cache
    // is repopulated by expandSkills and still amortises across nested
    // invocations of the same skill.
    clearSkillCache();

    let session = this.sessions.get(this.sessionKey(sessionId));

    // If session exists but is closed, remove it so a fresh one is created
    if (session && session.status === 'closed') {
      this.sessions.delete(this.sessionKey(sessionId));
      session = undefined;
    }

    // Validate config on existing session
    if (session && request.config) {
      throw new Error(
        'Config can only be provided on the first request for a session. ' +
          'This session already has a config set.',
      );
    }

    // Create session if it does not exist. The session's AiClient is built with
    // the per-request env applied here; on a reused session, `AI_MODEL` /
    // `AI_API_KEY` / `AI_GATEWAY_URL` are re-applied per batch in
    // `executeStepsInternal` so a saved `.env` edit takes effect on the next run.
    if (!session) {
      // Per-project recording outputs: the browser context is created — with or
      // without `recordVideo` — and the report/video/log output dir is fixed at
      // session creation, BEFORE the per-batch project bundle is resolved. So
      // the record mode (`browser.video`) AND the output dir
      // (`reports.outputDir`, anchored at the project root) must come from the
      // TEST's own aiui.config.json, resolved up front here — not the server's
      // startup config. This makes both take effect on the server/TestBench
      // path, matching how cache/env/data are already per-project, and the CLI
      // runner. (Props consumed at session creation read this.config unless
      // threaded — see feedback_thread_new_config_to_server_bundle.)
      const { videoMode, reportOutputDir } = await this.resolveSessionOutput(request);
      session = await this.createSession(
        sessionId,
        request.config,
        request.env,
        videoMode,
        reportOutputDir,
      );
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
        .then(async () => {
          try {
            return await this.executeStepsInternal(
              session,
              sessionId,
              request,
              onEvent,
              signal,
              internal,
            );
          } catch (err) {
            // A throw from the run leaves the compile's generation queue with
            // nobody to hand its answer to — and still spending model calls
            // for every step already offered. `finish` is the only other exit,
            // and it is far below the point where the compiler exists.
            await this.discardLiveCompile(session, 'the run threw');
            throw err;
          } finally {
            // Guarantee a FINALIZED last-run record on EVERY run exit — including
            // early run-setup failures (malformed bundle, missing skill,
            // re-run-anchor-not-found, partial-rerun refusal) that return/throw
            // before recordLastRun runs. Without this a STOP-recovery client
            // polling GET /sessions/:id/last-run "until finalized" hangs. Surfaced
            // by issue 030's run-start reset, which clears the prior run's entry
            // that used to mask this. The guard makes the normal/abort paths
            // (already finalized) a no-op; the queue serializes runs, so this
            // run's finally settles before the next run starts. See issue 031.
            if (!this.lastRunInfo.get(this.sessionKey(sessionId))?.finalized) {
              this.recordLastRun(sessionId, {
                finalized: true,
                tokens: {
                  total: session.tokenTracker.runTotal,
                  input: session.tokenTracker.runInputTotal,
                  output: session.tokenTracker.runOutputTotal,
                },
              });
            }
          }
        })
        .then(resolve, reject);
    });

    return resultPromise;
  }

  /**
   * Get the current state of a session. Returns null if the session does not exist.
   */
  async getSession(sessionId: string): Promise<SessionState | null> {
    const session = this.sessions.get(this.sessionKey(sessionId));
    if (!session || session.status === 'closed') {
      return null;
    }

    // A state read must not start a browser (§4.6). An unlaunched session is a
    // real, listable session with no page — report it with empty url/title
    // rather than throwing, which is what every other "page is in an
    // intermediate state" case here already does.
    const page = session.browserSession?.pageTracker.getActive();
    let currentUrl = '';
    let pageTitle = '';
    let screenshotBase64 = '';

    try {
      if (!page) throw new NoBrowserLaunchedError();
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
   * Read the active page of a session — visible text, or the cleaned DOM.
   * See stories/page-content.md.
   *
   * Returns null for an unknown or closed session (the route answers 404) and
   * throws `PageCaptureError` when the page could not be read. It deliberately
   * does NOT return empty content for a failed capture: "the page says
   * nothing" and "we could not read the page" are different answers, and a
   * caller that cannot tell them apart will confidently report the first.
   *
   * The read is NOT queued behind `queueTail`. A run holds the queue for as
   * long as it takes, and a read that blocks for minutes is not a GET — so
   * this reads out of band (as `getSession` already does) and reports
   * `status` so a caller knows the page may be moving.
   *
   * The reading itself is `capturePageContent` (stories/tab-peek.md): the same
   * function `GET /cdp/browsers/:port/tabs/:targetId/content` calls, so a
   * session read and a tab read cannot drift. Everything left here is what a
   * SESSION adds — the lookup, and the `status` a tab has no equivalent of.
   */
  async getPageContent(sessionId: string, opts: PageContentOptions): Promise<PageContent | null> {
    const session = this.sessions.get(this.sessionKey(sessionId));
    if (!session || session.status === 'closed') {
      return null;
    }

    // Reading a page is not a reason to open a browser (§4.6). Distinct from
    // the `null` above, which the route turns into a 404: "this session has no
    // browser yet" and "this session does not exist" have opposite remedies.
    if (!session.browserSession) throw new NoBrowserLaunchedError();

    const page = session.browserSession.pageTracker.getActive();
    const captured = await capturePageContent(page, session.browserConfig, opts);

    return {
      sessionId,
      status: session.status === 'executing' ? 'executing' : 'active',
      ...captured,
    };
  }

  /** Max distinct sessions we remember finalized-run info for (bounded growth). */
  private static readonly LAST_RUN_INFO_LIMIT = 200;
  private static readonly ROW_RUN_LIMIT = 50;

  /**
   * The session's active page, for a caller that DRIVES it rather than reads it.
   *
   * Deliberately narrower than handing back the `ManagedSession`: the
   * credential broker needs a `Page` and nothing else about the session, and a
   * whole-session accessor would let every future caller reach the tracker, the
   * config and the run state without anyone deciding that it should.
   *
   * Returns null for an unknown or closed session, which the route turns into
   * a 404 — the same shape `getPageContent` uses for the same condition.
   */
  activePageFor(sessionId: string): Page | null {
    const session = this.sessions.get(this.sessionKey(sessionId));
    if (!session || session.status === 'closed') return null;
    // Throws rather than returning null: null already means "unknown or closed
    // session" here, and the route answers that with a 404. A session that
    // simply has not launched a browser yet is a different answer (§4.6) and
    // gets its own status.
    if (!session.browserSession) throw new NoBrowserLaunchedError();
    return session.browserSession.pageTracker.getActive();
  }

  /**
   * Record the finalized-run info for a session (issue 021). Bounded LRU-ish:
   * re-inserting moves the key to the end; we evict the oldest once over the cap.
   */
  /**
   * Append one finished row to this session's accumulator, starting a fresh
   * one on row 1.
   *
   * Row 1 dropping any existing entry is what stops a re-run inheriting the
   * previous run's rows — the same reason `postSteps` deletes `lastRunInfo` at
   * run start.
   */
  private accumulateRow(sessionId: string, row: RowReport, outputDir: string): void {
    const key = this.sessionKey(sessionId);
    const index = (row.dataRowIndex ?? 0) + 1;
    if (index === 1) this.rowRuns.delete(key);

    const existing = this.rowRuns.get(key);
    if (existing) {
      existing.rows.push(row);
      return;
    }
    this.rowRuns.set(key, { rows: [row], reportOutputDir: outputDir });
    if (this.rowRuns.size > SessionManager.ROW_RUN_LIMIT) {
      const oldest = this.rowRuns.keys().next().value;
      if (oldest !== undefined) this.rowRuns.delete(oldest);
    }
  }

  /**
   * Render the accumulated rows as the run's one report, then clear them.
   *
   * `notRun` comes from the client because only the client knows which rows it
   * planned and never reached — a matrix that silently omits the rows a Stop
   * skipped reads as if they passed. Returns null when there is nothing
   * accumulated, which the route turns into a 404 rather than a 500, so a
   * double-post after a crash is harmless.
   */
  async finalizeRowRun(
    sessionId: string,
    notRun: UnrunRow[] = [],
  ): Promise<{ reportPath: string } | null> {
    const key = this.sessionKey(sessionId);
    const acc = this.rowRuns.get(key);
    if (!acc || acc.rows.length === 0) return null;
    this.rowRuns.delete(key);

    const merged = mergeRowReports(acc.rows, notRun);
    const reportPath = await generateReport(merged, acc.reportOutputDir);
    logger.info(`Report saved: ${reportPath} (${acc.rows.length} row(s))`);

    // The stop path is exactly the one that must still produce a report: a
    // client that stopped mid-run closed its SSE stream and will recover this
    // path by polling `GET /sessions/:id/last-run`. It posts the finalise from
    // its `finally` whether or not the stream survived, so recording here —
    // rather than on a batch, which wrote no report — is what makes that work.
    const previous = this.lastRunInfo.get(key);
    this.recordLastRun(sessionId, {
      finalized: true,
      tokens: previous?.tokens ?? { total: 0, input: 0, output: 0 },
      reportPath,
    });

    return { reportPath };
  }

  private recordLastRun(sessionId: string, info: LastRunInfo): void {
    this.lastRunInfo.delete(this.sessionKey(sessionId));
    this.lastRunInfo.set(this.sessionKey(sessionId), info);
    if (this.lastRunInfo.size > SessionManager.LAST_RUN_INFO_LIMIT) {
      const oldest = this.lastRunInfo.keys().next().value;
      if (oldest !== undefined) this.lastRunInfo.delete(oldest);
    }
  }

  /**
   * Last finalized-run info for a session — report path + frozen token totals.
   * Served by `GET /sessions/:id/last-run` so a client that stopped the run can
   * recover what the dropped `done` event carried (issue 021). Returns
   * `{ finalized: false, tokens: 0s }` when nothing is recorded yet (the run
   * hasn't finalized), so the client polls until `finalized` rather than
   * guessing a timeout. Survives session deletion (a browser-closing stop).
   */
  /**
   * The last completed run of an OPEN session, in full — the `sessionId`
   * input to a compile. Null when the session is gone, closed, or has not run,
   * which is the compile endpoint's cue to record instead.
   */
  /**
   * Is this session open, and is a run in flight in it?
   *
   * `null` when there is no such open session. Unlike `getSession` this touches
   * no page — it is a yes/no the compiler asks before recording in a caller's
   * session, and a paused run (step mode, a tool debugger) reads as
   * `executing` because it is: the batch is parked inside it.
   */
  sessionStatus(sessionId: string): 'active' | 'executing' | null {
    const session = this.sessions.get(this.sessionKey(sessionId));
    if (!session || session.status === 'closed') return null;
    return session.status === 'executing' ? 'executing' : 'active';
  }

  getLastRun(sessionId: string): LastRunInfo {
    return (
      this.lastRunInfo.get(this.sessionKey(sessionId)) ?? {
        finalized: false,
        tokens: { total: 0, input: 0, output: 0 },
      }
    );
  }

  /**
   * The run settings in force — server-wide, and for one session
   * (stories/run-settings.md §6).
   *
   * Returns `null` when `sessionId` names a session that is not here, so the
   * route can 404. Answering with the base config instead would tell a caller
   * asking about session X what session Y-or-nobody is doing, which is the
   * confusion this whole report exists to remove.
   *
   * Reads only retained state — no page, no browser, no project bundle — so it
   * is safe on a GET and costs nothing.
   */
  getRunSettings(sessionId?: string): RunSettingsReport | null {
    // The server base: no project config in play (so the comparison inside
    // `resolveRunSettings` reports everything as `'server'`) and no overrides.
    const serverBase = resolveRunSettings(this.config, this.config, this.config.ai.model, {})
      .effective;
    if (sessionId === undefined) return { server: serverBase, session: null };

    const session = this.sessions.get(this.sessionKey(sessionId));
    if (!session || session.status === 'closed') return null;

    // The last run's resolution is the truthful answer for a session that has
    // run: it reflects that batch's PROJECT config, which nothing here can
    // re-resolve without a test file path. A session that has not run yet has
    // no project config to reflect, so its overrides fold over the server base.
    const effective =
      session.lastEffectiveSettings ??
      resolveRunSettings(this.config, this.config, this.config.ai.model, session.runSettings)
        .effective;
    return {
      server: serverBase,
      session: {
        sessionId,
        overrides: { ...session.runSettings },
        effective,
      },
    };
  }

  /**
   * List all active (non-closed) sessions.
   */
  getActiveSessions(): SessionListItem[] {
    const items: SessionListItem[] = [];

    for (const [id, session] of this.sessions) {
      if (session.status === 'closed') continue;

      // `?.` — a session whose browser has not launched yet (§4.6) is still a
      // session worth listing; it simply has no url to report.
      const page = session.browserSession?.pageTracker.getActive();
      let currentUrl = '';
      let pageTitle = '';

      try {
        currentUrl = page?.url() ?? '';
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
        cdp: cdpBinding(session),
        // The sync variant cannot await a target-id resolution, so it reports
        // the url alone rather than blocking. The async list below is what
        // `GET /sessions` — and therefore `list_sessions` — actually serves.
        tab: currentUrl === '' ? null : { targetId: null, url: currentUrl },
      });
    }

    return items;
  }

  /**
   * List all active sessions with async page title resolution.
   */
  async getActiveSessionsWithTitles(): Promise<SessionListItem[]> {
    // **Parallel, and every page read bounded.** This route had no deadline of
    // its own while awaiting two things that can hang: `page.title()`, which
    // carries no timeout (the runner races it for exactly this reason), and the
    // target-id lookup. Sequentially, per-session budgets also *sum* — three
    // sessions on one wedged CDP browser took 6 s against `list_sessions`'s own
    // 5 s abort, so the caller was told the listing timed out rather than being
    // given it. Both fixed here: the work fans out, so the cost is the slowest
    // session rather than their total.
    const live = [...this.sessions].filter(([, s]) => s.status !== 'closed');

    return Promise.all(
      live.map(async ([id, session]) => {
        // `?.` for the same reason as the sync listing above: a session that
        // has not launched a browser yet (§4.6) still gets a row.
        const page = session.browserSession?.pageTracker.getActive();
        let currentUrl = '';
        try {
          currentUrl = page?.url() ?? '';
        } catch {
          // ignore — a closed page still has a session row worth reporting
        }

        const [pageTitle, tab] = await Promise.all([
          briefly(
            (async () => {
              try {
                return page ? await page.title() : '';
              } catch {
                return '';
              }
            })(),
            PAGE_READ_TIMEOUT_MS,
            '',
          ),
          briefly(
            (async () => {
              try {
                return (await session.browserSession?.pageTracker.activeTabRef()) ?? null;
              } catch {
                // A diagnostic field must never be the reason a listing fails.
                return null;
              }
            })(),
            PAGE_READ_TIMEOUT_MS,
            null,
          ),
        ]);

        return {
          sessionId: id,
          status: (session.status === 'executing' ? 'executing' : 'active') as 'executing' | 'active',
          currentUrl,
          pageTitle,
          totalStepsExecuted: session.totalStepsExecuted,
          cdp: cdpBinding(session),
          tab,
        };
      }),
    );
  }

  /**
   * Which live session, if any, is driving each tab of the CDP browser on
   * `port` — `targetId` → `sessionId`.
   *
   * Serves two callers with one join: the tab listing's `sessionId` field, and
   * the close guard. Both want one name per tab, which is what this reduction
   * of `sessionsHoldingTargets` gives them — and what the errand guard cannot
   * use, for the reason that method's doc gives.
   */
  async sessionsByTarget(port: number): Promise<SessionsByTarget> {
    const { byTarget: all, complete } = await this.sessionsHoldingTargets(port);
    const byTarget = new Map<string, string>();
    for (const [targetId, holders] of all) {
      // First writer wins. Two sessions can legitimately hold the same tab
      // (they share the browser's context), and for both of this method's
      // callers — a listing label and a refusal — naming one is enough.
      const first = holders[0];
      if (first) byTarget.set(targetId, first.sessionId);
    }
    return { byTarget, complete };
  }

  /**
   * The same join, with every holder and its status
   * (stories/errands.md §The wheel).
   *
   * The errand guard is the caller that needs both: an idle session on a tab
   * blocks nothing, a session with a batch in flight blocks the borrow, and the
   * first-holder-per-target reduction above cannot express the difference — an
   * idle winner would hide the executing session behind it.
   *
   * `sessionsByTarget` is derived from this rather than the other way round, so
   * there is one sweep and one definition of who holds what.
   *
   * Sessions are filtered by port first, so a project running launch-mode
   * sessions pays nothing — those are on disposable browsers with no CDP port
   * and can never hold a tab of this one.
   *
   * **Only this server's sessions are visible.** A tab driven by another
   * Sessions API server, or by a human clicking in the window, is unknowable
   * from here — consistent with the standing decision that parallel users of
   * one CDP browser own the consequences.
   */
  async sessionsHoldingTargets(port: number): Promise<SessionsHoldingTargets> {
    const byTarget = new Map<string, SessionTabHolder[]>();
    let complete = true;

    await Promise.all(
      [...this.sessions].map(async ([id, session]) => {
        if (session.status === 'closed') return;
        // `Number(...)` rather than `!==`: `POST /sessions` casts `body.config`
        // without validating it, so a hand-rolled client sending
        // `"port": "51000"` gets a working CDP session that a strict compare
        // would skip — and this is a guard, so skipping it fails open.
        if (Number(session.sessionConfig.cdp?.port) !== port) return;
        try {
          // Every browser the session tracks, NOT `session.browserSession` —
          // that field is a snapshot of whichever browser is active, and
          // `openBrowser` auto-promotes the one it launches. A session that
          // attached to a CDP tab and then opened a second browser would
          // otherwise report the *launch-mode* browser's tabs, so the tab it
          // is really driving would look unheld and the close guard would let
          // it be yanked mid-run.
          const perBrowser = await Promise.all(
            session.browserTracker.all().map((b) => b.pageTracker.resolvedTargetIds()),
          );
          // Read after the sweep, not before it: the question a guard is
          // asking is "is this session running RIGHT NOW", and the enumeration
          // can take long enough for a batch to start or end inside it. The
          // fresher read is the honest one, and it errs towards letting a
          // just-finished session's tab be borrowed — the direction
          // stories/errands.md chose for a borrow, which is bounded by one
          // request.
          const status = session.status === 'executing' ? 'executing' : 'active';
          for (const sweep of perBrowser) {
            if (!sweep.complete) complete = false;
            for (const targetId of sweep.ids) {
              const holders = byTarget.get(targetId);
              if (holders) holders.push({ sessionId: id, status });
              else byTarget.set(targetId, [{ sessionId: id, status }]);
            }
          }
        } catch {
          // A session whose tabs cannot be enumerated at all contributes
          // nothing — but the join is then no longer the whole truth, and a
          // guard reading it must know that rather than seeing a confident
          // "nobody holds this tab".
          complete = false;
        }
      }),
    );

    return { byTarget, complete };
  }

  /**
   * Close a session: shut down the browser and remove it from the map.
   */
  /**
   * Abandon the compile riding this session, if any, without a result.
   *
   * The queue spends model calls; a compile nobody is going to collect must
   * not keep doing that. Called when a fresh compile supersedes an abandoned
   * one, when a run throws out from under one, and when the session closes.
   */
  private async discardLiveCompile(session: ManagedSession, why: string): Promise<void> {
    const open = session.liveCompile;
    if (!open) return;
    session.liveCompile = undefined;
    logger.debug(`Session "${session.id}": discarding the open compile (${why}).`);
    await open.compiler.dispose().catch((err: unknown) => {
      logger.debug(`Could not dispose the compile for ${open.testFilePath}: ${String(err)}`);
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(this.sessionKey(sessionId));
    if (!session) return;
    // Before the browser goes: an open compile has a queue running, and the
    // session is the only thing that still knows about it.
    await this.discardLiveCompile(session, 'the session is closing');

    // §4.5 — "session close resets the surface and releases the lock". Ahead
    // of the browser teardown, which can throw: a lock left behind refuses
    // every computer-mode run on this machine until a stale-pid takeover or a
    // human deletes the file, and this process is still alive, so the
    // takeover would not fire.
    leaveComputerMode(
      surfaceStateOf(session),
      session.id,
      this.deps.computerLock,
      { quiet: true },
    );

    // closeAll covers every browser the tracker owns — the initial one plus
    // any added by openBrowser. Closing only browserSession would leak named
    // browsers from multi-browser tests.
    const closeContext = (): Promise<void> => session.browserTracker.closeAll();

    try {
      if (session.pendingVideo) {
        // Finalise the most recent run's video. finalizeMainPageVideo closes
        // the context (writing the .webm), then saves/renames it — or, for
        // retain-on-failure on a passing run, deletes it. On a kept file we
        // re-render that run's report HTML with `videoRelPath` set, overwriting
        // the file in place so "Open Last Report" then shows the <video>.
        const pending = session.pendingVideo;
        const savedAbs = await finalizeMainPageVideo({
          page: session.mainPage,
          mode: session.videoMode,
          passed: pending.passed,
          videoDir: session.videoDir,
          stableBaseName: videoBaseNameFor(pending.report, pending.dataRowIndex),
          closeContext,
        });
        if (savedAbs) {
          try {
            // POSIX-style relative path so <video src> resolves cross-OS.
            pending.report.videoRelPath = pathRelative(session.reportOutputDir, savedAbs)
              .split(sep)
              .join('/');
            // A data-driven row has no report of its own to re-render. Setting
            // the path above is the whole job: the accumulator holds this same
            // object, and `mergeRowReports` lifts the path onto the row's line
            // in the matrix when the run is finalised. Strictly simpler than
            // the re-render-in-place below, and the only option — the merged
            // report does not exist yet.
            if (pending.dataRowIndex !== undefined) {
              logger.info(`Session video attached to row ${pending.dataRowIndex + 1}`);
            } else {
              await generateReport(pending.report, session.reportOutputDir);
              logger.info(`Report re-rendered with session video: ${pending.reportPath}`);
            }
          } catch (err) {
            logger.warn(`Failed to attach session video to report for "${sessionId}": ${String(err)}`);
          }
        }
      } else {
        await closeContext();
      }
    } catch {
      // Best effort
    }

    session.status = 'closed';
    this.sessions.delete(this.sessionKey(sessionId));
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
    sessionConfig:
      | {
          baseUrl?: string;
          timeout?: string;
          /** Raw `## Config: viewport:` spec — resolved here, see below. */
          viewport?: string;
          cdp?: { port: number; tab?: string; profile?: string };
        }
      | undefined,
    envOverrides: Record<string, string> | undefined,
    /** Resolved per-project record mode (from the test's `browser.video`). */
    videoMode: VideoMode,
    /** Absolute, project-anchored output dir — reports, videos, and the run log
     *  all land under here (see resolveSessionOutput). */
    reportOutputDir: string,
  ): Promise<ManagedSession> {
    logger.info(`Creating session "${sessionId}"`);

    // Per-test viewport (stories/per-test-viewport.md §3/§4). Resolved FIRST,
    // before the AI client, the context load and — crucially — the browser
    // launch: an invalid value must fail the batch with the §1 error and no
    // browser side effects, and this is the only place on the server path where
    // that is still true (everything past `launchBrowser` has a window to tear
    // down).
    //
    // The server's own `this.config.browser` is never mutated — the launch gets
    // a fresh object below, so concurrent sessions without the key on this same
    // server are untouched (§4).
    const fixedViewport = resolveViewportSpec(sessionConfig?.viewport);
    if (fixedViewport && sessionConfig?.cdp) {
      // §1's conflict, at the server's equivalent of the CLI's parse-to-launch
      // layer. `launchBrowser` refuses this pairing too, but only after the
      // session bookkeeping above it — refusing here keeps the message the one
      // that names both `## Config` keys the author actually typed.
      throw new Error(
        viewportCdpConflictError(
          sessionConfig.viewport!.trim(),
          String(sessionConfig.cdp.port),
        ),
      );
    }

    // Apply per-request env to a fresh ai config copy. Server's process.env is
    // never mutated; concurrent sessions stay isolated.
    const aiConfig = applyEnvToAiConfig(this.config.ai, envOverrides);

    // Video recording (Tier 1 — main page only). Thread the videos/ dir so the
    // launched context records when the resolved per-project `videoMode` isn't
    // 'off'. Under CDP launchBrowser short-circuits before newContext, so
    // nothing records.
    const videoDir = pathJoin(reportOutputDir, 'videos');

    // THE LAUNCH IS DEFERRED (SPEC-use-computer.md §4.6). Everything the launch
    // needs is computed HERE, at creation, and frozen into this closure — the
    // viewport spec and its `cdp` conflict, the record mode, the videos dir.
    // What moved is only *when* the browser appears: the first step that runs
    // while `session.surface` is `browser`, which for every test written before
    // computer mode is step 1. A test that opens with `[use computer]` never
    // triggers it and never starts a browser at all.
    //
    // `session.browserSession` is assigned by the step boundary, not from
    // here. What the closure DOES hold of the session is `created` below, and
    // only to read a value that does not exist yet when this runs.
    //
    // `browser.launchArgs` is per PROJECT (§5.10: `--disable-print-preview` is
    // how a test reaches the OS print dialog), and the project's config is not
    // known at creation — the steps handler resolves the bundle and writes
    // `session.browserConfig` before the first step, which is before this
    // closure runs. So it is read LATE, off the session, rather than frozen
    // from `this.config.browser` with everything else.
    let created: ManagedSession | undefined;
    const launcher = async (): Promise<BrowserSession> => {
      const launchArgs = created?.browserConfig?.launchArgs ?? this.config.browser.launchArgs;
      // Override only `video` with the per-project record mode; the rest of the
      // browser config stays server-global. videoDir is co-located with where
      // reports are written (the project-anchored reportOutputDir) so the
      // report's relative <video> link resolves.
      const launched = await launchBrowser(
        // `fixedViewport` is spread in ONLY when the test declared one, so a
        // server (or project, §8) that pinned its own keeps it on the sessions
        // that said nothing — which is the §1 precedence, test over project,
        // expressed as an absence rather than an override.
        {
          ...this.config.browser,
          video: videoMode,
          // Present only when someone configured it, so the server's own stays
          // in force for a project that said nothing.
          ...(launchArgs !== undefined && { launchArgs }),
          ...(fixedViewport ? { fixedViewport } : {}),
        },
        sessionConfig?.cdp,
        {
          videoDir,
          // §4's launch line: the size AND its source. Passed whenever a size is
          // in effect at all, so a project-wide pin is named as such instead of
          // reading like the test's own choice.
          ...((fixedViewport ?? this.config.browser.fixedViewport)
            ? { viewportSource: describeViewportSource(sessionConfig?.viewport) }
            : {}),
        },
      );
      // BASE-URL NAVIGATION MOVED HERE WITH THE LAUNCH, and so did the
      // teardown around it. An invalid baseUrl makes `page.goto` reject, and
      // the browser it just opened is not tracked anywhere yet — the tracker
      // only registers the session this closure RESOLVES with — so a throw
      // would leak the window. Close what we opened, then rethrow: the step
      // boundary turns the rejection into that step's failure.
      try {
        if (sessionConfig?.baseUrl) {
          logger.info(`Session "${sessionId}": navigating to base URL ${sessionConfig.baseUrl}`);
          await launched.page.goto(sessionConfig.baseUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          });
        }
      } catch (err) {
        try {
          await closeBrowser(launched);
        } catch {
          // Best-effort cleanup; surface the ORIGINAL error to the caller.
        }
        throw err;
      }
      return launched;
    };
    const browserTracker = BrowserTracker.deferred(launcher);

    // Nothing below launches a browser any more, so the orphaned-browser case
    // this try/catch was written for (a throw between the launch and
    // `this.sessions.set`) can no longer happen from the launch itself. It is
    // kept because `closeAll()` over an unlaunched tracker is a no-op and an
    // `openBrowser` inside a future setup step would put that case back.
    try {
      const tokenTracker = new TokenTracker();
      const aiClient = new AiClient(aiConfig, tokenTracker);
      const apiResponseStore = new ApiResponseStore();

      // Load context files once per session
      const context = await loadContextFiles(this.config.tests.contextDir);
      if (context.files.length > 0) {
        logger.info(`Session "${sessionId}": loaded ${context.files.length} context file(s)`);
      }

      // (baseUrl navigation lives in `launcher` above — it needs a page.)

      const session: ManagedSession = {
        id: sessionId,
        // Both filled by the step boundary at the first browser-surface step.
        browserSession: undefined,
        browserTracker,
        mainPage: undefined,
        // Every session starts on the page (§4.5). `[use computer]` is the
        // only thing that changes it, and it is a STEP, so it cannot have run
        // yet.
        surface: 'browser',
        videoMode,
        reportOutputDir,
        videoDir,
        status: 'active',
        // Startup defaults until the first batch resolves the project's own.
        browserConfig: this.config.browser,
        desktopConfig: this.config.desktop,
        sessionConfig: sessionConfig ?? {},
        configSet: sessionConfig !== undefined,
        // Empty, not seeded from the server config: an override means "the
        // caller asked for this", and pre-filling it would report every value
        // as session-sourced from the first run onward.
        runSettings: {},
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
        pauseAtNextCodeBehind: false,
        deadSectionsReported: new Set<string>(),
      };

      // What the deferred launcher reads `launchArgs` off when it eventually
      // runs. Assigned here rather than captured above because the closure is
      // built before this object exists.
      created = session;

      this.sessions.set(this.sessionKey(sessionId), session);
      return session;
    } catch (err) {
      logger.warn(
        `Session "${sessionId}": creation failed — closing any browser it opened. ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        await browserTracker.closeAll();
      } catch {
        // Best-effort cleanup; surface the ORIGINAL error to the caller.
      }
      throw err;
    }
  }

  private async executeStepsInternal(
    session: ManagedSession,
    sessionId: string,
    request: StepRequest,
    onEvent?: RunEventListener,
    signal?: AbortSignal,
    internal?: InternalRunOptions,
  ): Promise<StepResponse> {
    session.status = 'executing';

    // A compile-mode run always captures the DOM either side of each step:
    // that is what generation reads, and a client made to remember two flags
    // would only discover it forgot one at Generate time
    // (stories/compile-as-you-go.md §Run & Compile).
    const captureStepContext = request.captureStepContext === true || request.compile !== undefined;

    // Re-apply the per-request env (.env) AI overrides to this session's client
    // so a saved AI_MODEL / AI_API_KEY / AI_GATEWAY_URL edit is picked up on the
    // next run without closing the session. Recomputed from the server base
    // (`this.config.ai`), NOT the session's current values, so deleting a line
    // from `.env` cleanly reverts to the base rather than sticking on the last
    // override. This runs at the top of the `queueTail`-serialized body (not in
    // `executeSteps`, which resolves the session before queuing) so it can never
    // mutate the shared AiClient config out from under a concurrent in-flight
    // batch.
    const desiredAi = applyEnvToAiConfig(this.config.ai, request.env);
    // Run settings merge FIRST, so the model override below sees this batch's
    // value and every later read in this function sees the same session state.
    // Per key (see `mergeRunSettings`) — a request carrying only `capture` must
    // not wipe a model set two batches ago.
    session.runSettings = mergeRunSettings(session.runSettings, request.runSettings);
    // The model override is applied AFTER `applyEnvToAiConfig` and beats it, so
    // "the agent asked for this" wins over "the project's .env says this" —
    // while `syncAuth` stays the single place the client is re-pointed, which
    // is what makes a model change take effect with no browser restart.
    const overrideModel = session.runSettings.model;
    const desiredModel =
      typeof overrideModel === 'string' && overrideModel.trim() !== ''
        ? overrideModel.trim()
        : desiredAi.model;
    // `gatewayUrl` rides along unconditionally: there is no run-setting for it
    // (stories/run-settings.md owns per-run knobs), so the `.env` value is the
    // whole story, and passing it every batch is what lets a corporate `.env`
    // edit re-point a live session instead of waiting for a recycle.
    //
    // `effectiveAiRoute` is the ONE object those three values are read from, so
    // what `[use computer]` checks (SPEC-use-computer.md §15.4) is by
    // construction what the client was just pointed at — and not
    // `runConfig.ai`, whose `gatewayUrl` and `apiKey` are spread from the
    // SERVER's startup config (`resolveRunSettings`) and so miss a project
    // `.env` that routes through the Copilot bridge.
    const effectiveAiRoute: VisionRouteAi = {
      model: desiredModel,
      gatewayUrl: desiredAi.gatewayUrl,
      apiKey: desiredAi.apiKey,
    };
    const aiChange = session.aiClient.syncAuth(
      effectiveAiRoute.model,
      effectiveAiRoute.apiKey,
      effectiveAiRoute.gatewayUrl,
    );
    if (aiChange) {
      logger.info(
        `Session "${sessionId}": ${aiChange} ` +
          `(${desiredModel === desiredAi.model ? 'from .env' : 'run setting'})`,
      );
    }

    const runStartTime = Date.now();
    // The session's TokenTracker lives for the whole session, accumulating
    // across every run. Snapshot here so this run's report counts only the
    // tokens spent during this run — otherwise a re-run (especially a fully
    // cache-served one that makes no AI calls) would inherit the prior run's
    // total. See src/utils/tokens.ts.
    session.tokenTracker.markRunStart();
    // Invalidate any prior run's finalized last-run record NOW, at the start of
    // THIS run — mirroring markRunStart above, which guards the same "a re-run
    // inherits the previous run's state" class of bug for tokens. recordLastRun
    // only writes at run END (finalized:true); without this reset a STOP would
    // recover the PREVIOUS run's stale finalized report via
    // GET /sessions/:id/last-run (a client polling "until finalized" sees the
    // stale entry immediately and wins the race against this run's own record).
    // getLastRun returns finalized:false for a missing entry, so the client
    // keeps polling until THIS run finalizes. See issue 030.
    this.lastRunInfo.delete(this.sessionKey(sessionId));
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
    /** What the steps that healed under AI cost this run, for the `done`
     *  event's healed clause (stories/codebehind-selector-ambiguity.md).
     *  `TokenTracker` keeps a run-wide total and no per-step figure, so
     *  attribution is that total's delta across the step — sound because
     *  steps run one at a time.
     *
     *  One known imprecision: on a Run & Compile the generation queue calls
     *  the model in the background (`liveCompile.offer` deliberately does not
     *  wait), so its tokens can land inside a step's window and inflate that
     *  step's share. The figure is advisory — it exists to make a recurring
     *  cost visible, not to bill anyone — and an ordinary run has no queue. */
    let healedTokens = 0;
    let tokensAtStepStart = 0;

    // Step-execution view of the inbound request. When skill expansion runs
    // (further down, once envDataCtx is resolved) these get rebound to the
    // flattened arrays; the loop only ever reads from them. Declared up
    // here so the `sourceLineFor` closure binds to the live values.
    // Dead-section warnings, deduped on the MESSAGE.
    //
    // The server sees one document as one batch or several and cannot tell
    // how a run was carved up, so it cannot ask "is this the first batch of a
    // run". Two attempts to infer that from the request shape were both
    // wrong: a positional check lost the warning for every run starting with
    // an `[input:]` step, and a document-shape key could not see skill files,
    // so a section that a skill edit had just orphaned went unreported.
    //
    // The message itself names the file, the section and the line, so it
    // changes exactly when the thing being reported changes — no guessing,
    // and nothing that can go stale. A targeted re-run stays silent
    // regardless: the user is looking at one step, not auditing the file.
    const emitDeadSection = (message: string): void => {
      if (session.deadSectionsReported.has(message)) return;
      session.deadSectionsReported.add(message);
      logger.warn(message);
    };
    const reportDeadSections = request.startAt === undefined;

    let effectiveSteps: string[] = request.steps;
    let effectiveSourceLines: number[] | undefined = request.sourceLines;
    let expansionOrigins: ExpandedStepOrigin[] | null = null;
    let expansionFrames: Record<string, FrameInfo> | null = null;
    /** The expander's own frame records (not the wire `FrameInfo`), kept for
     *  code-behind: resolving which `.steps.ts` a step binds into needs
     *  `kind`/`uri` plus the skill scope tables the wire shape doesn't carry. */
    let expandedFrames: Record<string, ExpandedFrame> = {};
    /** Parallel to `effectiveSteps` — each step's authored match-side text.
     *  Absent expansion, the request's steps are already that (contract §2.1). */
    let expansionRawSteps: string[] = request.steps;
    /**
     * Parallel to `effectiveSteps` — non-null on a control-flow guard, with the
     * index range of its body and the end of its chain
     * (stories/control-flow.md §Design).
     *
     * Obtained from the server's OWN `expandSkills` call rather than from the
     * wire: a control line is `kind: 'step'` like any other, and the client
     * neither knows nor needs to know which lines are guards. All-null for
     * every batch with no control lines, which is every batch written before
     * this feature.
     */
    let expansionControls: (ControlRecord | null)[] = request.steps.map(() => null);
    let codeBehind: CodeBehindRegistry = CodeBehindRegistry.empty();
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

    /**
     * A compile-mode request that refuses before (or without) reaching its
     * steps must still answer the compile. The proposal only exists as a
     * `compile:result` frame, and a stream that ends with none looks — to the
     * client's no-outcome branch — exactly like an older server that dropped
     * the `compile` field, so the author would be told to check their server
     * build instead of being shown the refusal. A minimal failed result whose
     * `error` is the refusal itself, emitted before `done`.
     */
    const emitCompileRefusal = (message: string): void => {
      if (request.compile === undefined || !request.testFilePath) return;
      emit({
        type: 'compile:result',
        status: 'failed',
        files: {},
        summary: {
          test: request.testFilePath,
          totalSteps: 0,
          compiled: 0,
          kept: 0,
          keptAi: 0,
          rounds: 0,
          tokensUsed: session.tokenTracker.runTotal,
          written: [],
          unproven: [],
          writtenOffAi: [],
          notAttempted: [],
          recordingDir: recordingDirFor(request.testFilePath),
          error: message,
        },
      });
    };

    /**
     * End a compile this request was carrying, whatever stage it is at.
     *
     * The two halves belong together and were previously the caller's job to
     * pair: a site that discarded without emitting left the client waiting on
     * a `compile:result` that never came (and reading the silence as an older
     * server), and one that emitted without discarding told the client the
     * compile was over while its queue kept spending model calls on the
     * session. Reads `session.liveCompile` rather than the local, so it also
     * covers the refusals that fire BEFORE the local compiler is built — where
     * a retained compiler from an earlier block of a split run is exactly what
     * would otherwise be stranded.
     */
    const refuseOpenCompile = async (message: string): Promise<void> => {
      if (request.compile === undefined || !request.testFilePath) return;
      if (session.liveCompile) {
        await this.discardLiveCompile(session, `the run refused: ${message}`);
      }
      emitCompileRefusal(message);
    };

    // Record the step that was in flight when the user STOPPED the run, so the
    // on-disk report marks where it stopped (issue 021). Called from the three
    // mid-step abort handlers (post-step, per-step catch, branched) — NOT the
    // loop-top between-step check, where no step is in flight. `base` is the
    // swallowed-abort StepResult when one exists (post-step path); otherwise a
    // minimal record. `index` is 1-based. Marked `interrupted` so the report
    // renders it distinctly and excludes it from the failed count.
    const recordInterruptedStep = (index: number, instruction: string, base?: StepResult): void => {
      const sourceSkill = outermostSkillName(expansionOrigins?.[index - 1]?.frameId, expansionFrames);
      const sourceSection = outermostSectionName(
        expansionOrigins?.[index - 1]?.frameId,
        expansionFrames,
      );
      fullStepResults.push({
        index,
        instruction,
        status: 'failed',
        turns: base?.turns ?? [],
        durationMs: base?.durationMs ?? 0,
        retried: base?.retried ?? false,
        interrupted: true,
        aiExplanation: 'Stopped by user (run aborted).',
        ...(base?.screenshotBase64 !== undefined && { screenshotBase64: base.screenshotBase64 }),
        ...(sourceSkill && { sourceSkill }),
        ...(sourceSection && { sourceSection }),
      });
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
      : openRunLogFile(request.testFilePath ?? sessionId, session.reportOutputDir);
    if (runLog) {
      runLog.stream.write(
        `# session=${sessionId} startedAt=${new Date().toISOString()} steps=${stepsTotal} mode=${fileMode}` +
          // Which row of a data-driven run this log covers. The logs stay one
          // file per row — they are written as the row runs, so there is no
          // merge point for a stream — and without this they are told apart
          // only by their timestamps.
          (request.dataRow !== undefined
            ? ` dataRow=${request.dataRow}/${request.dataRowCount ?? request.dataRow}`
            : '') +
          '\n',
      );
      logger.info(`Run log: ${runLog.path}`);
    }

    // Said once per row, so the editor's output log and the Test Explorer's
    // both carry the row without either having to reconstruct it.
    if (request.dataRow !== undefined) {
      emit({
        type: 'output',
        msg: `Row ${request.dataRow} of ${request.dataRowCount ?? request.dataRow}`,
        kind: 'info',
      });
    }
    // What this run must never print (stories/secret-redaction.md). The
    // parameter map and the env context are built further down; until then a
    // log line has nothing to mask. Read fresh each time — captures add to it.
    let secretsNow = (): string[] => [];
    const removeFileBridges = runLog
      ? attachRunLogBridges(runLog, fileMode, () => secretsNow())
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
    // Retain the project's browser settings for out-of-band reads
    // (`getPageContent`), which have no test file to re-resolve a bundle from.
    // It is also what the deferred launcher reads `browser.launchArgs` off at
    // launch time — the launch happens at the first browser-surface step,
    // which is after this line.
    session.browserConfig = projectConfig.browser;
    // The computer surface's per-project section (§5.10), for the same reason
    // and read by `[use computer]` and by `computerContextFor` below. NOT off
    // `runConfig`: that is the server's config with four values re-sourced.
    session.desktopConfig = projectConfig.desktop ?? this.config.desktop;

    // This batch's run settings: server base → project bundle → the session's
    // retained overrides (stories/run-settings.md §2).
    //
    // `runConfig` is what both executor call sites are handed in place of
    // `this.config`. It is a COMPLETE Config — spread from `this.config` with
    // only the four values this story owns re-sourced — because those call sites
    // take the whole object, and a partial one would blank out every setting
    // nobody asked to change.
    //
    // `desiredAi.model` — the PRE-override model — not `desiredModel`. The
    // resolver applies the override itself, and giving it the post-override
    // value would leave it unable to tell "the project's .env chose this" from
    // "the agent asked for this", which is the provenance the whole
    // first-class-field decision exists to keep.
    //
    // Compile is a request FOR AI, so the switch does not gate it. Three ways
    // in, all per-request and none retained: the in-process flag the
    // compile-runner sets; a `compile` on the wire — which is how "Compile
    // This Step" and "Repair this step" actually arrive (they ride
    // `compile: 'steps'` on the step route, not `POST /codebehind/compile`), so
    // the in-process flag alone would leave the commands §9 names as carve-outs
    // gated on an `ai: off` session; and `withinCompileRun`, which is the same
    // carve-out for the rest of a logical run that only compiles once. A
    // data-driven compile puts `compile` on row 1 alone (an entry serves every
    // row), and the switch is resolved per batch — so without the third way the
    // author's ONE gesture is half carved out and half refused. Both of its
    // values buy the carve-out; which one it is decides `codeBehindOff`
    // instead.
    const bypassAiPolicy =
      internal?.bypassAiPolicy === true ||
      request.compile !== undefined ||
      request.withinCompileRun !== undefined;
    // The third way in is the quiet one, and this is what stops it being
    // invisible (stories/run-settings.md §9). The other two leave a trace the
    // author already sees: the internal flag belongs to a compile-runner or
    // errand-runner call that announces itself, and a `compile` on the wire puts
    // a proposal on the stream and a recording beside the test. A
    // `withinCompileRun` batch opens no compiler and proposes nothing, so on a
    // project that set `ai.allowInRuns: false` its AI calls would otherwise be
    // the one thing in the log with no reason next to it.
    //
    // The test's NAME and the mode, and nothing else: the mode is what decides
    // whether code-behind also executes, so the two questions a reader has are
    // answered by the one line. No step text, no parameters, no row — a row
    // cell can be a password, and this line is written whatever the policy is.
    // One line per batch, beside the decision it explains, so a 100-row
    // compile's log reads one line per row rather than one per step.
    //
    // `testFilePath` is required alongside this field (api-server rejects it
    // without one), so the fallback is a type guard, not a case.
    if (request.withinCompileRun !== undefined) {
      const named = request.testFilePath ? basename(request.testFilePath) : 'this test';
      logger.info(
        `Session "${sessionId}": AI allowed for this batch — it is part of a compile of ` +
          `${named} (withinCompileRun: ${request.withinCompileRun}). ` +
          'A compile is a request for AI, so the run AI switch does not gate it.',
      );
    }
    const resolvedSettings = resolveRunSettings(
      this.config,
      projectConfig,
      desiredAi.model,
      session.runSettings,
      // `desiredAi`, not `this.config.ai`: whether this run has a key at all is
      // decided by the client's `.env` layered over the server base, and a
      // server started keyless would otherwise report a keyed project as
      // having no AI.
      { ai: desiredAi, ...(bypassAiPolicy && { bypassAiPolicy: true }) },
    );
    // Policy-off is the only state that veils the client. A run that is keyless
    // for want of a key must keep `AiNotConfiguredError`, whose advice ("set
    // AI_API_KEY") is right there and wrong here.
    const aiPolicyOff = resolvedSettings.effective.aiOffReason === 'policy';
    // Safe to mutate the shared client here for `syncAuth`'s reason: this is the
    // top of the `queueTail`-serialized body, so no concurrent batch on this
    // session is in flight.
    session.aiClient.setAiPolicy(!aiPolicyOff);
    // `opts.keyless` for the executor. The predicate, not the key check alone:
    // policy-off has to reuse the heal fall-through skip and its stale/
    // healSkipped sidecar, or a compiled step that broke under `ai: off` would
    // be invisible to compile-repair.
    //
    // `desiredModel`, not `desiredAi.model` — the one line here that wants the
    // POST-override model rather than the pre-override one the resolver above
    // is deliberately given. `aiConfigured` is model-aware now (a
    // self-authenticating provider needs no key), and this is asking what the
    // run can actually do, not where a setting came from: it is the same model
    // `syncAuth` just pointed the client at, so a keyless `bedrock/` project
    // overridden to `anthropic/…` reports having no AI instead of reporting
    // `on` and dying on an empty key.
    const runKeyless =
      !aiConfigured({ ...desiredAi, model: desiredModel }) ||
      resolvedSettings.effective.ai === 'off';
    // The session's own viewport, re-applied on top (stories/per-test-viewport.md
    // §2: "every browser the test opens inherits it").
    //
    // `runConfig` is rebuilt from `this.config` — the SERVER's startup config —
    // on every batch, so the size this session launched at is not in it. The
    // mid-test `openBrowser` action relaunches from `config.browser`
    // (step-executor.ts), so without this line a `viewport: mobile` test's
    // second browser comes up at desktop size while the first stays mobile, and
    // the two disagree with nothing in the report to say why.
    //
    // Re-resolved from the retained RAW spec rather than cached as a size: the
    // string already survived validation at session creation (an invalid one
    // never got a browser), so this cannot fail, and one source of truth beats
    // two fields that can drift.
    const sessionViewport = resolveViewportSpec(session.sessionConfig.viewport);
    // Structured table reads (SPEC-structured-table-reads.md §7.10). The test's
    // `## Config: tableStructure:` over the PROJECT's `tables.structure` —
    // `projectConfig`, never `this.config`. `resolvedSettings.config` is spread
    // from the SERVER's startup config, so reading `tables` off it would give
    // every project the server's own answer and silently ignore the
    // `aiui.config.json` sitting beside the test (the same trap `browserConfig`
    // above is a note about).
    const tableStructure = resolveTableStructure(
      request.config?.tableStructure,
      tableStructureOf(projectConfig),
    );
    const runConfig: Config = {
      ...resolvedSettings.config,
      ...(sessionViewport
        ? { browser: { ...resolvedSettings.config.browser, fixedViewport: sessionViewport } }
        : {}),
      tables: { ...resolvedSettings.config.tables, structure: tableStructure },
    };
    session.lastEffectiveSettings = resolvedSettings.effective;
    let envDataCtx: EnvDataContext | null = projectBundle.envBundle
      ? {
          env: projectBundle.envBundle.env,
          data: projectBundle.envBundle.data,
          envName: projectBundle.envBundle.envName,
        }
      : null;

    // Load the test's own frontmatter `dataSources` (forwarded by the client)
    // into `${<name>.X}` namespaces, resolved relative to the test file's dir.
    // This makes test-level named sources interpolate on the server path too,
    // not just the CLI parse path. Loaded per-request (tied to this test file),
    // so it's deliberately NOT part of the per-project bundle cache.
    if (envDataCtx && request.dataSources && request.testFilePath) {
      const testDir = dirname(request.testFilePath);
      const extraData: Record<string, DataObject> = {};
      for (const [name, declaredPath] of Object.entries(request.dataSources)) {
        // `env` / `data` are the built-in namespaces — a source using either
        // would be silently shadowed in interpolation. The CLI parser rejects
        // these at parse time; fail loudly here to keep parity.
        if (name === 'env' || name === 'data') {
          throw new Error(
            `Frontmatter dataSources cannot use the reserved name "${name}" — ` +
            `'env' and 'data' are the built-in namespaces.`,
          );
        }
        const absPath = resolveDataSourcePath(declaredPath, testDir);
        extraData[name] = await loadDataFromPath(absPath, envDataCtx.env);
      }
      if (Object.keys(extraData).length > 0) {
        envDataCtx = { ...envDataCtx, extraData };
      }
    }
    // Frame inputs join the secret list, not just the parameter map. A looped
    // section's row is bound as frame `inputs` and interpolated into the step
    // text, so a `password` column would otherwise print in clear in the
    // report's instruction, the console line, the run log and the recording —
    // and so would a literal `[skill: login password="x"]` argument, which has
    // had the same hole all along (stories/data-driven-rows.md, decision 10).
    //
    // Read fresh on every call, as the parameter half already is: frames are
    // built after this assignment, and captures keep adding to the map.
    secretsNow = () => {
      const merged = { ...resolvedParameters, ...Object.assign({}, ...Object.values(frameInputs)) };
      // A copy carries none of the loop's marks (the registry is by object
      // identity), and unmarked, every `row.<column>` in it would take the
      // author rule — `AU` back in the mask set because a column is called
      // `keyword`, the round-2 defect through a new door (§7.6).
      inheritLoopBindings(resolvedParameters, merged);
      return runSecrets({ parameters: merged, envData: envDataCtx });
    };

    // `## Config: unmask: keyword, data.keys.public` — names and `${…}` refs
    // this test declares are NOT secrets, despite `isSecretName` matching them
    // (stories/placeholder-preserving-actions.md, decision 2). Comma-separated,
    // matched against the exact name or the exact ref. TestBench does not send
    // this field yet; a request without it behaves exactly as before.
    const unmaskNames: ReadonlySet<string> = new Set(
      (request.config?.unmask ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    );

    /**
     * The two fields every `frame:scope` carries besides the scope itself:
     * whose the dotted names are, and which names the author has unmasked
     * (§7.6). Without them the client has a mixed map and no way to read it —
     * a copy carries none of the loop-binding registry's marks, and `unmask`
     * lived entirely server-side — so TestBench applied the two-segment rule
     * to every dotted name and the mask to every unmasked one.
     *
     * Computed at each emit rather than once: `applyPassBindings` rewrites the
     * registry on every pass and `clearDottedKeys` unmarks what a `Set`
     * rebind drops, so the answer is only true for the instant it is read.
     *
     * `bindings` is unconditional, `[]` included — the client reads an ABSENT
     * field as "older server, nothing known" and falls back to today's
     * behaviour, so an empty list has to be a value it can receive. `unmask`
     * is omitted when empty, which keeps an ordinary run's payload byte for
     * byte what it was.
     *
     * The same pair for a frame whose scope merges `frameInputs`: those
     * inputs are either a caller's flat skill args or the very pass bindings
     * this registry was marked from (`cloneFramesForPass` copies
     * `pass.bindings` into them), so the list already names them.
     */
    const scopeMasking = (): { bindings: string[]; unmask?: string[] } => ({
      bindings: loopBindingsOf(resolvedParameters),
      ...(unmaskNames.size > 0 && { unmask: [...unmaskNames] }),
    });

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
    // A *full* (re)load builds a fresh catalogue instance: needed when there's
    // none cached, the dir changed, or the previous scan found no files (a dir
    // that was missing/empty and may since have been populated). `reload: true`
    // makes the server's catalogue re-import an *edited* tool file (issue 033
    // Part 1) — defeating the process-lifetime caches that the one-shot CLI
    // doesn't have. A same-dir, populated catalogue is *refreshed* instead (see
    // the else-branch) so added/removed files are picked up (Part 2) without
    // discarding the loaded tools.
    const cachedCatalogue = session.toolCatalogue;
    const needsFullLoad =
      !!request.toolsDir &&
      (!cachedCatalogue ||
        session.toolCatalogueDir !== request.toolsDir ||
        cachedCatalogue.indexedCount === 0);
    if (request.toolsDir && needsFullLoad) {
      try {
        session.toolCatalogue = await loadToolCatalogue(request.toolsDir, { reload: true });
        session.toolCatalogueDir = request.toolsDir;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Session "${sessionId}": failed to load tool catalogue "${request.toolsDir}": ${message}`);
        emit({ type: 'output', msg: `Tool catalogue load failed: ${message}`, kind: 'error' });
        await refuseOpenCompile(`Tool catalogue load failed: ${message}`);
        emit({ type: 'done', status: 'error', effectiveSettings: resolvedSettings.effective });
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
    } else if (request.toolsDir && cachedCatalogue) {
      // Same dir, populated catalogue: re-walk to pick up added/removed tool
      // files (Part 2). Edits to existing files are handled lazily in `resolve`
      // via the per-file change signature (Part 1), so this is index-only (no
      // imports). Wrapped so a dir deleted mid-session degrades to a warning +
      // the existing catalogue rather than crashing the batch.
      try {
        await cachedCatalogue.refreshIndex();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          `Session "${sessionId}": tool index refresh failed for "${request.toolsDir}": ${message}`,
        );
      }
    }
    // A batch that omits `toolsDir` deliberately KEEPS a catalogue an earlier
    // batch loaded — `session.toolCatalogue` is sticky, matching the
    // `envBundle`/`sessionConfig` precedent, so TestBench's Continue (which
    // re-sends steps without re-sending `toolsDir`) still dispatches tools.
    //
    // stories/mcp-no-project.md's "no tools project-less" guarantee is enforced
    // MCP-side instead (`isCodeStep` in assemble.ts refuses `[skill:]`/
    // `[tool:]` before a user-scope run reaches here), not by dropping the
    // catalogue on a bare batch — that would regress Continue to close a hole
    // the client scan already closes. The scan was reviewed to be a strict
    // superset of this server's own tokenizer, so nothing project-less that
    // would dispatch here survives it.
    const toolCatalogue = session.toolCatalogue;

    // Skill expansion — when the caller supplies `skillsDir`, flatten
    // `[skill: ...]` lines into their bodies before execution and remember
    // the per-step origin so step-into-aware clients see `frame:push` /
    // `frame:pop` events around each skill body. Without `skillsDir` the
    // existing flow is preserved verbatim (raw steps shipped to the runner).
    // …and when any step is a control line, for the same reason the CLI's
    // parser widened its own gate: the tail is a step the expander has to
    // place, and skipping expansion would ship `While the Next button is
    // enabled, Go to the next page` to the model as one prose instruction
    // (stories/control-flow.md). A file with a chain but no sections and no
    // skills reaches the server exactly like that.
    const hasControlLines = request.steps.some((step) => parseControlLine(step) !== null);
    if (request.skillsDir || hasSections(request) || hasControlLines) {
      try {
        const expansion = await expandSkills(
          request.steps,
          // Optional since sections landed: a project can define inline
          // sections and no skills at all, in which case there is no skills
          // directory to point at. Passing `request.skillsDir!` here would
          // typecheck and hand `undefined` to a parameter typed `string`.
          request.skillsDir,
          envDataCtx ?? undefined,
          request.testFilePath,
          // Thread sourceLines so top-level [skill: ...] invocations
          // get a non-zero `frame.line` — the client uses it to paint
          // running/pass on the test file's `[skill: ...]` step row.
          // Without this, the row stays blank.
          request.sourceLines,
          {
            ...(request.sections && { sections: request.sections }),
            // No `rawSteps` on this path: the server's incoming steps are
            // already the raw/instruction form, so the contract §2.1
            // fallback (`rawSteps?.[i] ?? steps[i]`) is exactly right.
            //
            // Dead-section liveness is a property of the DOCUMENT, and this
            // batch may be a slice of it — a resumed run after a breakpoint,
            // or an `[input:]` split. Two separate corrections are needed:
            //
            //  - scan `fullSteps`, so a section invoked only by a step
            //    outside this batch is not reported dead. Scanning the batch
            //    would cry wolf on precisely the runs a user is debugging.
            //  - emit only on the batch that STARTS a run, so one dead
            //    section produces one warning rather than one per breakpoint
            //    segment.
            //
            // Scoping it to full-document batches instead would have meant a
            // user who sets any breakpoint never sees the warning at all.
            warnDeadSections: reportDeadSections,
            onDeadSection: emitDeadSection,
            ...(request.fullSteps && { livenessSteps: request.fullSteps }),
          },
        );
        effectiveSteps = expansion.steps;
        stepsTotal = effectiveSteps.length;
        expansionOrigins = expansion.origins;
        expandedFrames = expansion.frames;
        expansionRawSteps = expansion.rawSteps;
        expansionControls = expansion.controls;
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
            // Not free: this conversion copies field by field, so an
            // iteration would be dropped here without naming it.
            ...(f.iteration !== undefined && {
              iteration: f.iteration,
              iterationCount: f.iterationCount,
            }),
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
        await refuseOpenCompile(`Skill expansion failed: ${message}`);
        emit({ type: 'done', status: 'error', effectiveSettings: resolvedSettings.effective });
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

    // ─── Code-behind registry ────────────────────────────────────────────
    //
    // Resolved per request, after expansion, from the test file's own project
    // — a `.steps.ts` sits beside the markdown, so it rides the same
    // per-request project resolution as `aiui.config.json` and `.env`.
    //
    // Unlike the action cache, this is safe on a subset batch: an entry is
    // bound by the step's authored text within its frame INSTANCE, so it does
    // not depend on which frame counter a batch happened to mint (issue 037).
    //
    // A compile-driven run overrides all of it: `disabled` for the Record (an
    // entry that serves its step leaves no transcript to generate from), and a
    // caller-supplied expansion + candidate paths for the Replay, so the
    // registry binds through the compiler's frames rather than a second
    // expansion the server would have to reproduce exactly.
    const cb = internal?.codeBehind;

    // The compile route posts steps that are ALREADY expanded.
    //
    // `POST /codebehind/compile` (src/server/compile-runner.ts, `sessionRunner`)
    // sends `test.steps` with no `skillsDir` and no `sections`, deliberately —
    // re-expanding server-side would be a second answer to "which `.steps.ts`
    // does step 7 bind into". So the block above never runs, and without this
    // `expansionOrigins` stays null: every step then reads as the ROOT frame.
    // A `### Section` body that returns would skip the rest of the TEST rather
    // than the rest of the section, call it "ended the run", and quote the
    // interpolated line — the one thing decision 4 says a reason may never do.
    //
    // Only these three. `expansionFrames` (the wire `FrameInfo` table) stays
    // null on purpose: seeding it would start emitting `frame:push`/`frame:pop`
    // on a route that has never sent them, which changes what a compile's
    // clients see rather than fixing what the run does.
    if (expansionOrigins === null && cb?.expansion) {
      // A prefix replay sends fewer steps than the compiler expanded
      // (`throughStep`), and the parallel arrays are indexed from 0 either way
      // — so they are clipped to this batch rather than trusted whole. A
      // shorter-than-expected table means the caller is describing some other
      // list, and the safe answer there is the fallback we already had.
      //
      // All three or none. Seeding the frames without the authored lines
      // would give a return frame-scoped reach while its reason quoted the
      // interpolated text — the one combination decision 4 forbids — and it
      // would do so silently, because both halves are individually valid.
      const n = effectiveSteps.length;
      if (cb.expansion.origins.length >= n && cb.expansion.rawSteps.length >= n) {
        expansionOrigins = cb.expansion.origins.slice(0, n);
        expandedFrames = cb.expansion.frames;
        expansionRawSteps = cb.expansion.rawSteps.slice(0, n);
      }
    }

    const expansionForBinding = (): Parameters<typeof buildCodeBehindRegistry>[0] =>
      cb?.expansion ?? {
        steps: effectiveSteps,
        rawSteps: expansionRawSteps,
        origins: expansionOrigins ?? effectiveSteps.map((_, i) => ({ inputIndex: i, frameId: '' })),
        frames: expandedFrames,
      };
    /**
     * The expansion the GENERATION registry binds through.
     *
     * Normally the run's own. For a `compile: 'steps'` request carrying
     * `compileScope`, the steps came from a `### Section` body but ran
     * detached at the root frame — so the run's expansion says "top level",
     * which is not where the runtime will look for the entry. A section frame
     * of that name is synthesized here and the binder derives file, section
     * and scope from it exactly as it does for a real one: no special case in
     * `buildCodeBehindRegistry`, and no second answer to "which `.steps.ts`
     * does this step bind into".
     *
     * `skillName` carries the section's name — that is the field
     * `resolveDefiningSite` reads a section frame's scope from — and
     * `parentId: null` keeps the variable scope empty, which is right for a
     * section of the test's own.
     */
    const scopedExpansionFor = (
      section: string,
      testFilePath: string,
    ): Parameters<typeof buildCodeBehindRegistry>[0] => {
      const frameId = 'compile-scope';
      return {
        steps: effectiveSteps,
        rawSteps: expansionRawSteps,
        origins: effectiveSteps.map((_, i) => ({ inputIndex: i, frameId })),
        frames: {
          [frameId]: {
            id: frameId,
            parentId: null,
            kind: 'section' as const,
            uri: testFilePath,
            invocationLine: null,
            skillName: section,
          },
        },
      };
    };

    // `compile: 'steps'` disables execution the way a Record does — a step
    // whose entry is broken has to run under AI to leave a transcript — but
    // it still needs the bindings, which is what the separate generation
    // registry below is for.
    //
    // `withinCompileRun: 'steps'` is the rest of that logical run: rows 2..N of
    // a Compile This Step in a data-driven file, which compile nothing (row 1
    // does) and must still run under AI. Left executing, they ran the entry the
    // author is repairing — it threw, healed, and marked ⚠ the step whose
    // repair was in flight — and none of that is visible in row 1's proposal.
    const codeBehindOff =
      cb?.disabled === true ||
      request.compile === 'steps' ||
      request.withinCompileRun === 'steps';
    if (request.testFilePath && !codeBehindOff) {
      codeBehind = await buildCodeBehindRegistry(expansionForBinding(), {
        testFilePath: request.testFilePath,
        ...(cb?.candidateFiles && { candidateFiles: cb.candidateFiles }),
      });
    }
    /**
     * Where generation looks up a step's target file, section scope and
     * occurrence. Normally the execution registry, which binds the same way;
     * with execution disabled it has to be built separately — silently (the
     * "entry matches no step" warnings belong to a run that was going to use
     * them) and against the author's real files, never a candidate.
     */
    let generationBindings: CodeBehindRegistry = codeBehind;
    if (request.compile !== undefined && codeBehindOff && request.testFilePath) {
      const scope = request.compileScope?.section;
      generationBindings = await buildCodeBehindRegistry(
        scope ? scopedExpansionFor(scope, request.testFilePath) : expansionForBinding(),
        { testFilePath: request.testFilePath, onWarn: () => {} },
      );
    }

    /**
     * The compile riding this run (stories/compile-as-you-go.md). Generation
     * trails the browser: each step is offered as it finishes, the queue is
     * serialized in step order, and the run never waits on it.
     */
    let liveCompile: LiveCompiler | undefined;
    // A compile that reaches into a loop is refused — but the check needs the
    // batch's `[startIndex, endIndex]`, which is not computed until well below
    // this point, so it lives there rather than here (search
    // `firstLoopInRange`). A chain is fine either way: its steps run at most
    // once, and an untaken branch is simply not attempted.
    if (request.compile !== undefined && request.testFilePath) {
      const testFilePath = request.testFilePath;
      const plan = effectiveSteps.map((step, i) => {
        const binding = generationBindings.bindingFor(i);
        const line = sourceLineFor(i);
        return {
          text: binding?.source ?? expansionRawSteps[i] ?? step,
          // Decided statically, before the run: a step with no entry is one
          // this compile means to write, and in `'steps'` mode every sent
          // step is. The whole-test block has to read the same for step 1 as
          // for step 9, and what step 9 will need is not knowable when step 1
          // is generated.
          //
          // A control line is never in scope, whatever the mode: the framework
          // dispatches it and it performs nothing, so there is no transcript to
          // write from — and a model told an `If …, then …` line was in scope
          // would offer code that makes the decision itself
          // (stories/control-flow.md, decision 12).
          inScope:
            expansionControls[i] === null &&
            (request.compile === 'steps' || binding?.entry === undefined),
          // …and out of the denominator entirely, which `inScope: false` alone
          // does not say: a step that already has an entry is also out of
          // scope, and it IS one of the steps this compile is about.
          ...(expansionControls[i] !== null && { dispatched: true }),
          ...(line > 0 && { line }),
        };
      });
      // A logical run reaches the server as SEVERAL requests whenever it is
      // split — an `[input:]` or `[interactive]` step between two stretches
      // of steps, or a breakpoint that ends one batch and leaves Continue to
      // send the next. Each block used to get a fresh compiler, so each read
      // the (unapplied) file from disk again, numbered its steps from 1, and
      // overwrote the previous block's recording. The compiler is retained on
      // the session instead, and every block adds to it.
      const open = session.liveCompile;
      if (open && request.compileContinues === true && open.key === compileLockKey(testFilePath)) {
        liveCompile = open.compiler;
        // The stream too, not just the plan: block 1's `emit` writes to an
        // SSE response that closed when block 1 answered, so without this the
        // frames for block 2's entries go nowhere.
        liveCompile.beginBlock(plan, signal, {
          emit,
          note: (msg, level) => emit({ type: 'output', msg, kind: level }),
        });
      } else {
        // A fresh logical run supersedes whatever the last one abandoned —
        // the author who paused at a breakpoint and never resumed, the run
        // whose `[input:]` prompt was cancelled. Without this the lock and
        // the queue would outlive them.
        if (open) await this.discardLiveCompile(session, 'superseded by a new compile');
        liveCompile = new LiveCompiler({
          mode: request.compile,
          testFilePath,
          // The SESSION's client and context, not a compile-built pair: a
          // session's `runSettings.model` override now covers generation and
          // Review as well as the run, which is the asymmetry this fixes.
          aiClient: session.aiClient,
          contextContent: session.contextContent,
          // The run never parses the markdown title, so the file's name is
          // what the prompt's test-info block gets.
          testName: basename(testFilePath, '.md'),
          ...(session.sessionConfig.baseUrl !== undefined && {
            baseUrl: session.sessionConfig.baseUrl,
          }),
          ...(envDataCtx && { envData: envDataCtx }),
          plan,
          ...(signal && { signal }),
          emit,
          note: (msg, level) => emit({ type: 'output', msg, kind: level }),
        });
      }
      // Held on the session so the next block finds it, and so an abandoned
      // one can be disposed and its lock released.
      session.liveCompile = {
        compiler: liveCompile,
        key: compileLockKey(testFilePath),
        testFilePath,
        steps: session.liveCompile?.steps ?? [],
        identities: session.liveCompile?.identities ?? {},
        startedAt: session.liveCompile?.startedAt ?? new Date(runStartTime).toISOString(),
        anyFailed: session.liveCompile?.anyFailed ?? false,
      };
    }
    // A strict run — a compile's replay — exists to find out whether the code
    // works on its own. A file that did not load has no code to run, so the
    // answer is "no", said before any step runs under AI and looks like "yes".
    if (cb?.strict && codeBehind.loadErrors.length > 0) {
      const { file, error } = codeBehind.loadErrors[0]!;
      const message = `code-behind file ${file} could not be loaded: ${error}`;
      logger.error(`Session "${sessionId}": ${message}`);
      emit({ type: 'output', msg: message, kind: 'error' });
      emit({ type: 'done', status: 'failed', effectiveSettings: resolvedSettings.effective });
      return {
        sessionId,
        status: 'failed',
        stepsCompleted: 0,
        stepsTotal,
        results: [],
        outputs: session.outputs,
        outputSources: { ...session.outputSources },
        error: { step: 0, message },
        pageTitle: '',
      };
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

    // Per-step cache keys are `${frameId}-${line}`, and frame ids are minted
    // by walking THIS batch (`f1`, `f2`, …). A subset batch expands only its
    // slice, so its ids restart from f1 and can name a different invocation
    // than the full run that wrote the entry — replaying a frozen action plan
    // against the wrong step. Verified: a full run writes `f2-7` for a section
    // body step and `f1-7` for a skill body step in another file; the resumed
    // batch then reads `f1-7` and gets the skill's plan.
    //
    // v1 rule (runtime spec §4.3): on a subset batch, skip per-step cache
    // reads AND writes for steps in non-root frames. Root-frame steps keep
    // their stable `frameId === ''` keys and stay cached. This trades some
    // hits for guaranteed-correct misses; aligning batch frame ids to the
    // full-document expansion would restore them and is future work
    // (issues/037).
    //
    // Subset batches are not only breakpoint continuations — `[input:]` /
    // `[interactive]` splits and run-selection also send `steps` ≠
    // `fullSteps`, so skill body steps lose per-step caching there too.
    const isSubsetBatch =
      request.fullSteps !== undefined && !arraysEqual(request.steps, request.fullSteps);
    // What this run learns about a region's structure, once
    // (SPEC-structured-table-reads.md §7.10, src/runner/structure-memo.ts).
    // Per BATCH, the same lifetime `stepCache` has: a batch is what the server
    // knows about, and a run split by a breakpoint or an `[input:]` simply
    // asks once more on the far side rather than reusing an answer from
    // before a pause the user may have spent editing the page.
    //
    // Deliberately NOT gated by `cacheEnabledForRequest`: that switch is about
    // replaying a frozen action plan, and this is about not asking the same
    // structural question twice in one run. A run with the cache off still
    // asks once.
    const structureMemo = createStructureMemo();
    let stepCache: StepCache | undefined;
    if (cacheEnabledForRequest && request.testFilePath) {
      // Reuse the project root already resolved for the env/data bundle (it was
      // hoisted out of this branch — it now runs for every request).
      const projectRoot = projectBundle.projectRoot;
      if (projectRoot) {
        const cacheDir = pathJoin(projectRoot, projectConfig.cache.dir, envCacheSegment(requestedEnvName ?? undefined));
        // Bundle-hash source (issue 016 Bug 2). The hash must change when a
        // skill body changes AND be stable across every batch of one document.
        // `effectiveSteps` (the expansion of this batch) is the right source
        // only when the batch IS the whole document; a subset batch must hash
        // the expansion of the FULL document so it matches a full run's hash.
        let cacheHashSource: string[];
        const choice = chooseCacheHashSource(
          request.steps,
          request.fullSteps,
          // Sections bake into the step text exactly as skill bodies do, so a
          // subset batch of a sectioned document must hash the FULL expansion
          // or it can never hit the cache a full run wrote.
          !!request.skillsDir || hasSections(request),
        );
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
              request.skillsDir,
              envDataCtx ?? undefined,
              request.testFilePath,
              request.sourceLines,
              {
                ...(request.sections && { sections: request.sections }),
                // This expansion exists only to compute a hash; its dead-
                // section warnings would be byte-identical to the ones the
                // execution expansion already emitted. Without this the user
                // sees every "defined but never invoked" warning twice on any
                // subset batch — and once more per resumed batch after a
                // breakpoint.
                warnDeadSections: false,
              },
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
        // issue 018: fold resolved env/data values into the hash source so a
        // data-file edit invalidates the cache exactly like a step-text edit.
        // Without this the hash sees the RAW `${data.x}` / `${source.x}`
        // placeholder, so changing the value behind it leaves the hash (and
        // every positional per-step key) unchanged and a cache HIT replays the
        // frozen action with the stale value. `{{params}}` are intentionally
        // left intact — interpolateEnvData ignores them, so the read-time param
        // interpolation still lets one cached plan serve many param values
        // (params ride the cache; data busts it). Applied to whichever branch
        // produced cacheHashSource, so full / subset / expanded hashes stay
        // mutually consistent. A bad ref throws here; fall back to the raw line
        // — a bad ref in this batch resurfaces at the real interpolation site
        // (the `interpolatedSteps` map below) with a precise file/line error.
        if (envDataCtx) {
          cacheHashSource = cacheHashSource.map((s) => {
            try {
              return interpolateEnvData(s, envDataCtx);
            } catch {
              return s;
            }
          });
        }
        try {
          stepCache = await StepCache.initialize(cacheDir, cacheDirName(request.testFilePath, projectRoot), cacheHashSource);
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
    //
    // A Set step is passed through UNINTERPOLATED, for two reasons that both
    // bite. `interpolateEnvData` throws on an unknown `${…}`, and this call
    // sits at method-body level with no `try` above it — so a bad reference
    // inside a Set template escaped the whole request as a server error
    // rather than failing its own step, which is exactly what the guard 600
    // lines below was written to prevent and could not, because this runs
    // first. And `identifyStepGroups` must see the same text the run loop
    // does (`parseSetStep(originalStep)`), or the two disagree about whether
    // a line is an assignment at all.
    const interpolatedSteps = envDataCtx
      ? effectiveSteps.map((s) => (parseSetStep(s) ? s : interpolateEnvData(s, envDataCtx)))
      : effectiveSteps;
    const stepGroups = identifyStepGroups(interpolatedSteps);

    // ── Control flow (stories/control-flow.md) ───────────────────────────
    //
    // Three hooks, the same three the CLI and the Runner UI have: `planForStart`
    // once, `planAtGuard` → gather → `planAfterGuard` before a guard, and
    // `planAfterStep` after every step. The decisions live in the shared
    // planner; what is local here is the event stream — frame clones per pass,
    // `step:pass output:'skipped'` for an untaken branch.
    const controls = expansionControls;
    const hasControls = controls.some((record) => record !== null);
    const controlState = createControlState(runConfig.execution.maxLoopIterations);
    const loops = new LoopRuntime();
    const skipQueue = new SkipQueue();
    const skipReasons = new Map<number, string>();
    /**
     * §4.5 — a skill call restores the caller's surface on return.
     *
     * Per RUN rather than per session, and the corner that costs is named
     * rather than hidden: a batch boundary INSIDE a skill body (TestBench
     * splits a batch at an `[input:]` or a breakpoint) starts a new stack, so
     * the surface the second batch reads as "the caller's" is whatever the
     * skill left it on. Nothing is lost that `[use browser]` cannot restore,
     * and the alternative — keeping the stack on the session — would key it on
     * frame ids that are only stable while the expansion is.
     */
    const skillSurfaces = new SkillSurfaceStack();
    /** Restore a surface on return from a skill, releasing the lock when the
     *  SKILL took it and the caller had not. A caller already in computer mode
     *  keeps it: the lock was never released and the adapter is still there. */
    const restoreSurface = (to: 'browser' | 'computer'): void => {
      if (to === 'browser') {
        leaveComputerMode(surfaceStateOf(session), session.id, this.deps.computerLock);
      }
    };
    /** Steps inside a loop body opt out of the per-step action cache: the
     *  cache rewrites one value per line and a pass is a different value
     *  (stories/control-flow.md, decision 12 — the rows story's reason). */
    const loopBodySteps = new Set<number>();
    for (const record of controls) {
      if (!record || !isLoopRecord(record)) continue;
      for (let k = record.bodyStart; k <= record.bodyEnd; k++) loopBodySteps.add(k);
    }

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
          ...scopeMasking(),
        });
      }
    };
    /**
     * The frame id to EMIT for expanded step `i`.
     *
     * Normally the one the expander minted. Inside a loop pass it is that
     * frame's per-pass clone: the flat step list does not grow when a loop
     * runs again, so the same indices are re-executed under a fresh frame id
     * and every consumer that reads a frame id from an event sees a frame it
     * has not seen before — which is what a fresh expansion already looks
     * like (stories/control-flow.md, decision 8).
     */
    const emittedFrameId = (i: number): string =>
      loops.frameFor(expansionOrigins?.[i]?.frameId ?? '');

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
      return expansionFrames[loops.frameFor(origin.frameId)];
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
    // Same seeding for the code-behind sibling — used when F11 relaunches a
    // run from a breakpoint pause (stories/codebehind-debugging.md).
    if (request.pauseAtNextCodeBehind) {
      session.pauseAtNextCodeBehind = true;
    }

    // Per-URI breakpoint sets for the server-side pause check. Skill-
    // file (and any non-test-file) breakpoints land here; the test file's
    // own breakpoints are skipped because the client already trims at
    // them before sending the request (legacy `trimAtBreakpoint` path).
    //
    // The skip is by FRAME, not by file. It used to drop the test file's
    // whole entry, which was equivalent while every step in the test file
    // belonged to the root frame. A section body lives in the test file too,
    // and the client's `trimAtBreakpoint` cannot see those lines — it trims
    // the unexpanded main flow, where the body does not appear — so dropping
    // the file wholesale would make a breakpoint on a section body line
    // silently never fire. Test-file entries are therefore kept, and the
    // per-step check below ignores them only for root-frame steps.
    const breakpointSetsByUri = new Map<string, Set<number>>();
    if (request.breakpointsByUri) {
      for (const [uri, lines] of Object.entries(request.breakpointsByUri)) {
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
      ...scopeMasking(),
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

    /**
     * Whether a `startAt`/`endAt` anchor in `uri` must match a line exactly
     * rather than snapping to the nearest step at or beyond it.
     *
     * The `>=` / `<=` fallbacks exist so a re-run still works when the target
     * file was edited and the exact line moved. They rely on document order
     * and execution order agreeing within a file — true for a skill body,
     * because the whole file is one contiguous run.
     *
     * Sections break that. A section is DEFINED below the main flow but
     * EXECUTES wherever it is called, so one file interleaves the two orders:
     *
     *     3. First          <- executes 1st
     *     4. Login          <- the call; expands to lines 8-9
     *     5. Last           <- executes 4th
     *     ### Login
     *     8. Type user      <- executes 2nd
     *     9. Submit         <- executes 3rd
     *
     * `startAt` = (test file, 5) means "re-run from Last". A `>=` scan walks
     * execution order and stops at the first step whose line is ≥ 5 — line 8,
     * inside the body — silently re-running the wrong steps.
     */
    const anchorNeedsExactLine = (uri: string): boolean =>
      hasSections(request) && uri === request.testFilePath;

    /** Frames enclosing expanded step `i`, innermost first. */
    const frameChainOf = (i: number): FrameInfo[] => {
      const chain: FrameInfo[] = [];
      const seen = new Set<string>();
      let id = expansionOrigins?.[i]?.frameId;
      while (id && !seen.has(id)) {
        seen.add(id);
        const frame = expansionFrames?.[id];
        if (!frame) break;
        chain.push(frame);
        id = frame.parentId ?? undefined;
      }
      return chain;
    };

    /**
     * Does expanded step `i` sit at anchor line `line` of `uri`?
     *
     * Two ways to sit at a line:
     *
     *  1. The step is authored there — its defining line, in that file.
     *  2. The step is part of what a CALL on that line expanded into. A call
     *     line is the most natural thing for a user to click, because it is
     *     the row they watched fail, and it vanishes from the expansion
     *     entirely — so matching defining lines alone refuses it outright,
     *     with a message blaming a stale file.
     *
     * Case 2 is answered from the frame ancestry, not from the step's own
     * input index. An earlier version used the input index, which only knows
     * about TOP-LEVEL calls, and then grew a second branch that matched a
     * section's `stepLines` to cover calls nested inside a body. That branch
     * could not distinguish "this body step expanded to nothing" from "this
     * body step expanded into another frame", so for a body starting with
     * `[skill: …]` it stepped over the whole skill and started after it —
     * silently, and reporting green.
     *
     * The ancestry knows. Every frame records the line it was invoked at, so
     * "was any frame enclosing this step invoked at `line`?" is exact at any
     * depth, and comparing against the INVOKING file (the parent frame's, or
     * the test file at the root) is what keeps a skill-file line number from
     * matching a test-file anchor that happens to share it.
     */
    const stepAtAnchor = (i: number, uri: string, line: number): boolean => {
      // Lines are 1-based. A frame whose `invocationLine` was null carries 0,
      // so without this an anchor of line 0 — reachable when a client sends a
      // short or absent `sourceLines` — would match those frames and start
      // the run somewhere it was never pointed at.
      if (line <= 0) return false;
      if (uriOfStep(i) === uri && (effectiveSourceLines?.[i] ?? -1) === line) return true;
      for (const frame of frameChainOf(i)) {
        if (frame.line !== line) continue;
        const invokedFrom = frame.parentId
          ? expansionFrames?.[frame.parentId]?.uri
          : request.testFilePath;
        if (invokedFrom === uri) return true;
      }
      return false;
    };

    // Note the deliberate asymmetry with `endAt` below: in exact mode
    // `startAt` has NO nearest-step fallback, so an anchor landing on a blank
    // line or a heading refuses the run. That is the safer failure for this
    // field specifically. A guessed END bound stops the run early — visible,
    // and the work already done still stands; a guessed START bound runs a
    // different set of steps and reports on them as if they were the ones
    // asked for. An error the user can correct beats that.
    let startIndex = 0;
    if (request.startAt) {
      const { uri: startUri, line: startLine } = request.startAt;
      const exact = anchorNeedsExactLine(startUri);
      startIndex = effectiveSteps.findIndex((_, i) => {
        if (exact) return stepAtAnchor(i, startUri, startLine);
        if (uriOfStep(i) !== startUri) return false;
        return (effectiveSourceLines?.[i] ?? -1) >= startLine;
      });

      // `stepAtAnchor` covers every anchor that produced a step, at any
      // depth. What remains is a MAIN-FLOW step that produced NONE: a skill
      // with an empty `## Steps` expands to nothing (sections refuse an empty
      // body, skills do not), so no frame exists to carry its invocation
      // line. Walk forward to the first step from a later input step.
      //
      // Its body-line twin — a zero-expansion step INSIDE a body — is
      // deliberately left to refuse. Walking forward from there would have to
      // guess which enclosing scope to continue in, and `startAt`'s posture
      // is to refuse rather than guess.
      if (exact && startIndex < 0) {
        let anchorInput = -1;
        for (let k = 0; k < request.steps.length; k++) {
          if ((request.sourceLines?.[k] ?? k + 1) === startLine) {
            anchorInput = k;
            break;
          }
        }
        if (anchorInput >= 0) {
          startIndex = effectiveSteps.findIndex(
            (_, i) => (expansionOrigins?.[i]?.inputIndex ?? -1) >= anchorInput,
          );
        }
      }

      if (startIndex < 0) {
        const message =
          `Re-run anchor not found: no step at or after line ${startLine} in ${startUri}. ` +
          `The skill may have changed since the failed run.`;
        logger.error(`Session "${sessionId}": ${message}`);
        emit({ type: 'output', msg: message, kind: 'error' });
        // A refusal must terminate the compile it rides on: the queue is
        // disposed (nothing ran, nothing is owed) and a failed
        // `compile:result` carries the refusal, so the client never
        // misreads the silence as an older server.
        await refuseOpenCompile(message);
        emit({ type: 'done', status: 'error', effectiveSettings: resolvedSettings.effective });
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
      const exact = anchorNeedsExactLine(endUri);
      let found = -1;
      for (let i = startIndex; i < effectiveSteps.length; i++) {
        if (exact) {
          // KEEP THE LAST match, matching both `endAt`'s documented contract
          // ("stop after the LAST step at or before this line") and the
          // non-exact path below. Two things depend on it:
          //
          //  - An end anchor on a section CALL line must run the WHOLE body.
          //    Every step of an invocation shares the call's input line, so
          //    keep-last lands on the body's final step; keep-first would
          //    log in and never submit, and report a green run for it.
          //  - Sections are defined BELOW the main flow, so the last step
          //    line of a sectioned document is a body line. Keep-first there
          //    truncates "run the whole file" to its first few steps.
          //
          // The cost is that a one-line range naming a body line of a section
          // invoked twice spans both invocations. That is unchanged from
          // before sections and matches the field's documented meaning; the
          // range is widened, never silently narrowed, which is the safer
          // direction of the two.
          if (stepAtAnchor(i, endUri, endLine)) found = i;
          continue;
        }
        if (uriOfStep(i) !== endUri) continue;
        const line = effectiveSourceLines?.[i] ?? Number.MAX_SAFE_INTEGER;
        if (line <= endLine) found = i;
      }

      // Exact mode disambiguates an anchor that names a real step when
      // document and execution order interleave. It says nothing about an
      // anchor naming no step at all — a blank line, a heading, a line past
      // the end — and refusing those outright made a sectioned document
      // hard-fail where a sectionless one degrades gracefully.
      //
      // The fallback resolves through the INPUT steps, not the expanded ones.
      // Input lines are the main flow, so they are monotonic in the document;
      // expanded lines are not, because a section's body is defined below the
      // call and executes at it. Scanning `effectiveSourceLines` for the
      // nearest preceding line therefore skipped whole invocations: an anchor
      // on the blank line just after a section call ran the step BEFORE the
      // call and nothing else, then reported the run passed. That is the
      // silent narrowing this feature keeps trying to introduce, and it is
      // why the previous comment here — "cannot mis-target" — was wrong.
      //
      // "Run through the last main-flow step at or before this line,
      // including everything it expands into" is what the user means, and it
      // is monotonic in the anchor line.
      // `found` comes from a scan windowed to `[startIndex, end)`, so it is
      // also -1 when the anchor names a real step that lies entirely BEFORE
      // the start — a range that runs backwards in EXECUTION order. Falling
      // back there resolved the end bound to a different line's step and
      // reported the narrowed run green, while every other inverted range is
      // refused explicitly. Require that no exact match exists ANYWHERE
      // before degrading.
      //
      // This does refuse one reading that used to work: on a sectioned
      // document, "select from a main-flow line down to a body line" is a
      // forward range in DOCUMENT order and an inverted one in execution
      // order. Falling back ran from the start anchor to the end of the
      // document — which honours the start and silently discards the end.
      // Being told the selection doesn't describe a runnable range beats
      // being given a different range and a green tick.
      const exactMatchExistsSomewhere =
        exact && effectiveSteps.some((_, i) => stepAtAnchor(i, endUri, endLine));
      if (exact && found < 0 && !exactMatchExistsSomewhere) {
        let lastInput = -1;
        for (let k = 0; k < request.steps.length; k++) {
          const inputLine = request.sourceLines?.[k] ?? k + 1;
          if (inputLine <= endLine) lastInput = k;
        }
        // Walk back over input steps that expanded to NOTHING. A skill with
        // an empty `## Steps` contributes no expanded step — sections guard
        // against an empty body, skills do not — so its call line has no
        // `inputIndex` in the origins at all. Resolving to it and stopping
        // there refused the run outright, on a real main-flow step, with a
        // message blaming a stale skill file.
        for (let k = lastInput; k >= 0 && found < 0; k--) {
          for (let i = startIndex; i < effectiveSteps.length; i++) {
            if (expansionOrigins?.[i]?.inputIndex === k) found = i;
          }
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
        // Same contract as the start-anchor refusal: end the compile with the
        // refusal rather than leaving it open and unanswered.
        await refuseOpenCompile(message);
        emit({ type: 'done', status: 'error', effectiveSettings: resolvedSettings.effective });
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
      // The same snap for a control structure: an `endAt` landing on a guard
      // runs to the end of what that guard opens — a chain's `chainEnd`, a
      // loop's `bodyEnd` — because a guard evaluated with its body sliced away
      // is a decision with no consequence (stories/control-flow.md §"Runs that
      // start or end mid-structure"). Idempotent on every ordinary step.
      if (hasControls) endIndex = snapEndAt(controls, endIndex);
      logger.info(
        `Session "${sessionId}": bounded re-run to step ${endIndex + 1}/${stepsTotal} (${endUri}:${endLine})`,
      );
    }

    // The compile's plan was built before the slice was known — it must stay
    // full-length (offers index it by absolute position, and the whole-test
    // prompt reads it all), but a step outside `[startIndex, endIndex]` is not
    // one this compile means to write, and the summary must not report it as
    // "not attempted". Bound the plan before any step is offered, so a
    // single-step compile reads "1 of 1" rather than "1 of 6, 5 not
    // attempted".
    if (liveCompile && (request.startAt !== undefined || request.endAt !== undefined)) {
      liveCompile.setSlice(startIndex, endIndex);

      // A slice cannot write an entry for occurrence k of a repeated step
      // while an EARLIER occurrence sits outside the slice with no entry yet:
      // `spliceEntry` places an entry at `spans[occurrence]` and APPENDS when
      // that slot does not exist, so the new entry would land at the wrong
      // occurrence and serve a different step. The client refuses exactly
      // this for test files (`resolveCompileTarget`'s repeated-step gate); a
      // skill-file slice reaches the server without that gate, so it is
      // enforced here — before anything runs or spends a token. An earlier
      // occurrence INSIDE the slice is fine: the queue generates in step
      // order, so its entry exists by the time the later one is placed; and
      // one that already has an entry is a replacement, not a placement.
      //
      // Scoped to a FRESH `'steps'` compile, which is the only shape that can
      // place an entry into a file it read from disk. A `'run'` continuation
      // carries `startAt` too (a Continue that resumes inside a section body),
      // and there the earlier occurrence's entry sits in the RETAINED
      // compiler's candidate rather than on disk — so this test would see it
      // missing and kill the author's whole run over the compile's own
      // bookkeeping.
      const guardOccurrences =
        request.compile === 'steps' && request.compileContinues !== true;
      for (let i = startIndex; guardOccurrences && i <= endIndex; i++) {
        const b = generationBindings.bindingFor(i);
        if (!b || b.occurrence === 0 || b.entry !== undefined) continue;
        // Occurrence is counted per FRAME INSTANCE (`buildCodeBehindRegistry`
        // keys its counter on the frame id), so a second invocation of the
        // same skill restarts at 0 and its steps are not siblings of the
        // first's — comparing across frames refuses a selection that is
        // already complete, with advice the author cannot act on.
        const frameOf = (k: number): string | undefined => expansionOrigins?.[k]?.frameId;
        const bFrame = frameOf(i);
        let blocked = false;
        for (let j = 0; j < startIndex && !blocked; j++) {
          const sib = generationBindings.bindingFor(j);
          blocked =
            sib !== undefined &&
            frameOf(j) === bFrame &&
            sib.file === b.file &&
            (sib.section ?? '') === (b.section ?? '') &&
            sib.source === b.source &&
            sib.occurrence < b.occurrence &&
            sib.entry === undefined;
        }
        if (!blocked) continue;
        const message =
          `"${b.source}" appears more than once in its scope, and a partial compile ` +
          `cannot place the entry for just one of them — it would land on the wrong ` +
          `occurrence. Include every occurrence in the selection, or compile the whole body.`;
        logger.error(`Session "${sessionId}": ${message}`);
        emit({ type: 'output', msg: message, kind: 'error' });
        await this.discardLiveCompile(session, 'a repeated step cannot be partially compiled');
        emitCompileRefusal(message);
        emit({ type: 'done', status: 'error', effectiveSettings: resolvedSettings.effective });
        return {
          sessionId,
          status: 'error',
          stepsCompleted: 0,
          stepsTotal,
          results: [],
          outputs: session.outputs,
          outputSources: { ...session.outputSources },
          error: { step: i + 1, message },
          pageTitle: '',
        };
      }
    }

    // ── A compile that reaches into a loop ────────────────────────────────
    //
    // Refused before anything runs (stories/control-flow.md, decision 12): an
    // entry is placed at `spans[occurrence]`, occurrence is counted per step
    // line, and a loop body runs the same lines a number of times only the page
    // decides — so the run would offer several transcripts for one slot and the
    // plan's "not attempted" arithmetic would count a step that ran three times
    // as one.
    //
    // Scoped to THIS batch's `[startIndex, endIndex]`, which is why it sits
    // here rather than beside the plan: the first version tested the whole
    // file, so a bounded Compile This Step on a step nowhere near the loop was
    // refused — and told to compile the section the loop runs, which the same
    // check would have refused as well. A section compile arrives as the
    // section's own steps (`compileScope`), detached from the guard, and now
    // passes for the same reason a step outside the loop does: no loop
    // structure overlaps the slice.
    if (request.compile !== undefined) {
      const loopIndex = firstLoopInRange(expansionControls, startIndex, endIndex);
      if (loopIndex !== undefined) {
        const message = loopCompileRefusal(
          expansionRawSteps[loopIndex] ?? effectiveSteps[loopIndex] ?? '',
        );
        logger.error(`Session "${sessionId}": ${message}`);
        emit({ type: 'output', msg: message, kind: 'error' });
        await refuseOpenCompile(message);
        emit({ type: 'done', status: 'error', effectiveSettings: resolvedSettings.effective });
        return {
          sessionId,
          status: 'error',
          stepsCompleted: 0,
          stepsTotal,
          results: [],
          outputs: session.outputs,
          outputSources: { ...session.outputSources },
          error: { step: loopIndex + 1, message },
          pageTitle: '',
        };
      }
    }

    // Step indexes that have already had their breakpoint pause consumed
    // in this batch. Without this, the loop would re-pause forever on
    // the same step after a Continue.
    //
    // Keyed by flat step INDEX, which is the same integer on every pass of a
    // loop — only the frame id changes. So the set has to be re-armed when a
    // loop starts a new pass, or one pause disables that breakpoint for the
    // rest of the run: `rearmLoopBreakpoints` below, and the reason it
    // exists.
    const consumedBreakpoints = new Set<number>();

    /**
     * A new pass of a loop re-arms every breakpoint inside it.
     *
     * `stories/control-flow.md` §"Painting, frames and the report" says "A
     * breakpoint on a body line fires on every pass". It fired once. Measured
     * live (scratchpad/liverun-2.md §2): a `While` took three passes with a
     * breakpoint on its body line and the run log holds exactly one
     * `step:awaiting` for that line — the other two passes ran straight
     * through, silently, and the author's breakpoint was gone for the rest of
     * the run.
     *
     * Narrow on purpose, so the reason the set exists survives: only this
     * loop's own range is dropped, and only where a pass is actually
     * starting. The resume batch after a pause is unaffected — the index it
     * resumed at is the guard's, cleared here before its body runs and after
     * that visit's own pause has already been taken.
     *
     * The guard's own index goes too, so a breakpoint on a `While` line
     * pauses before each evaluating visit rather than only the first. The
     * whole `[bodyStart, bodyEnd]` range goes, which takes nested guards and
     * their bodies with it — a new outer pass re-arms everything inside it.
     */
    const rearmLoopBreakpoints = (guard: number, record: ControlRecord): void => {
      if (consumedBreakpoints.size === 0) return;
      consumedBreakpoints.delete(guard);
      for (let k = record.bodyStart; k <= record.bodyEnd; k++) consumedBreakpoints.delete(k);
    };

    /**
     * Record one step the run decided not to take.
     *
     * The convention the branched path already set: `step:pass` with
     * `output: 'skipped'` on the step's own line. It stays because the
     * extension is an HTTP client of whichever server the workspace points at,
     * and a client that stopped reading it would repaint the untaken branch
     * green against a server nobody had restarted.
     *
     * What rides with it now is `reason` and `skipKind` — additive fields an
     * older server simply omits. `reason` is the sentence the report row
     * already carried, so the hover and the log lines can say WHY rather than
     * only that something was skipped; `skipKind: 'not-taken'` is how a
     * consumer tells this apart from the `[input:]` skip that used to be the
     * only producer of this event (see `src/mcp/run-fold.ts`, which warned
     * that an untaken `Otherwise` "needs a human" until it could).
     *
     * The `results` entry is `'skipped'`, not `'passed'`: that union gained a
     * third value with `stories/step-flow-control.md` decision 9, and the
     * docstring on `StepResultResponse` says exactly why — "reporting it
     * `passed` would be a green row for work that never happened".
     * `fullStepResults` has always carried the real status, which is what the
     * report renders as `—`.
     *
     * The frame stack is deliberately NOT transitioned: nothing ran in that
     * frame, and pushing it would report the run as having entered a section
     * it never entered. The event carries the frame explicitly, which is what
     * clients scope the line with.
     */
    const emitSkippedStep = (k: number): void => {
      // Never outside this batch's slice: a bounded run reports on the steps it
      // was asked about, and a chain's untaken half can sit past `endAt`.
      if (k < startIndex || k > endIndex) return;
      const instruction = effectiveSteps[k] ?? '';
      const frame = frameInfoFor(k);
      const reason = skipReasons.get(k) ?? 'Skipped';
      results.push({
        step: instruction,
        status: 'skipped',
        actions: [],
        screenshot: '',
        reasoning: reason,
        outputs: {},
      });
      const row = skippedResult({
        index: k + 1,
        instruction,
        reason,
        loop: loops.markerFor(k),
      });
      // The untaken tail's rows show under their section badge, which is what
      // makes a skipped block readable as "the branch that was not taken"
      // rather than as eight loose grey lines.
      const skill = outermostSkillName(expansionOrigins?.[k]?.frameId, expansionFrames);
      const section = outermostSectionName(expansionOrigins?.[k]?.frameId, expansionFrames);
      if (skill) row.sourceSkill = skill;
      if (section) row.sourceSection = section;
      fullStepResults.push(row);
      emit({
        type: 'step:pass',
        line: sourceLineFor(k),
        output: 'skipped',
        reason,
        skipKind: 'not-taken',
        ...(frame && { frame }),
      });
      // Counted, unlike a return's skips, which are deliberately not
      // (decision 9, "it counts steps that EXECUTED"). The two producers
      // disagree here and the divergence is documented rather than hidden —
      // stories/control-flow.md §"What `stepsCompleted` counts". The
      // `[input:]` skip path has incremented it since long before either
      // feature, and `stepsCompleted` is what a client's progress bar counts
      // against `stepsTotal`: a chain whose untaken half stopped counting
      // would leave every branching run's bar short of the end.
      stepsCompleted++;
      session.totalStepsExecuted++;
    };

    /** Release every queued skipped step the run has now moved past, so the
     *  report and the event stream both read in file order (see `SkipQueue`). */
    const flushSkips = (before: number | 'all'): void => {
      for (const k of before === 'all' ? skipQueue.takeAll() : skipQueue.take(before)) {
        emitSkippedStep(k);
      }
    };

    /** Where the run goes after step `i`: the next line, or back to a loop's
     *  guard when `i` closed its body. The third of the planner's three hooks,
     *  applied at every point the loop advances. */
    const advanceAfter = (i: number): number => {
      if (!hasControls) return i + 1;
      const after = planAfterStep(controls, i, controlState);
      return after ? after.next : i + 1;
    };

    /**
     * Clone the tail's frames for a loop pass, and stamp the iteration.
     *
     * The flat list does not grow when a loop runs again — the runtime jumps
     * back to the guard and re-runs the same indices — so the pass needs its
     * own frame ids or every pass would paint into the previous one's frame.
     * `iteration` goes on the OUTERMOST clone only (the tail's own frame): a
     * skill invoked from inside the body is not itself an iteration of
     * anything. `iterationCount` is omitted while a `While` / `Repeat` runs,
     * which is the case runner-core's `FrameInfo` doc now names.
     */
    const cloneFramesForPass = (
      guardIndex: number,
      record: LoopRecord,
      pass: { iteration: number; count?: number; bindings?: Record<string, string> },
    ): void => {
      if (!expansionFrames || !expansionOrigins) return;
      const guardFrame = expansionOrigins[guardIndex]?.frameId ?? '';
      // Monotonic per guard, so a loop nested inside another loop's body — whose
      // `iteration` restarts at 1 on every entry — cannot re-mint an id it
      // already used and overwrite that pass's frame in `expansionFrames`.
      const ordinal = loops.currentPassOrdinal;
      for (let k = record.bodyStart; k <= record.bodyEnd; k++) {
        // Walk out from the step's own frame to the guard's, cloning each
        // level THIS pass has not cloned yet. The test is the current pass's
        // own alias map rather than `frameFor`: an alias an enclosing loop
        // installed is not this pass's clone, and reading it as one gave every
        // inner pass the outer pass's frame (see `clonedInCurrentPass`).
        const chain: string[] = [];
        let cur: string | undefined = expansionOrigins[k]?.frameId;
        while (cur && cur !== '' && cur !== guardFrame && !loops.clonedInCurrentPass(cur)) {
          chain.push(cur);
          cur = expansionFrames[cur]?.parentId ?? undefined;
        }
        for (const original of chain.reverse()) {
          const source = expansionFrames[original];
          if (!source) continue;
          const cloneId = `${original}~g${guardIndex}i${ordinal}`;
          const parent = source.parentId ? loops.frameFor(source.parentId) : source.parentId;
          const outermost = (source.parentId ?? '') === guardFrame;
          expansionFrames[cloneId] = {
            ...source,
            id: cloneId,
            parentId: parent,
            ...(outermost && {
              iteration: pass.iteration,
              ...(pass.count !== undefined && { iterationCount: pass.count }),
            }),
          };
          // The bound item, so the Variables view shows what this pass is
          // working on — the frame-scoped twin of writing it into
          // `resolvedParameters`, which is what makes `{{account}}` resolve.
          frameInputs[cloneId] = {
            ...(frameInputs[original] ?? {}),
            ...(outermost ? (pass.bindings ?? {}) : {}),
          };
          loops.aliasFrame(original, cloneId);
        }
      }
    };

    // A run that starts INSIDE a tail treats that tail's guard as taken: the
    // chain's other members and their tails are skipped, a partial loop pass
    // counts as pass 1, and a `For each` resumes at the list's second element.
    // Seeds `controlState`, so it runs before the first guard is visited.
    if (hasControls) {
      const startPlan = planForStart(controls, startIndex, controlState);
      for (const k of eachSkipped(startPlan.skip)) {
        skipReasons.set(k, 'Skipped: the run started inside another branch of this decision');
        skipQueue.add([k]);
      }
    }

    try {
      for (let i = startIndex; i <= endIndex; i++) {
        // ONE-SHOT DEBUGGER FLAGS — read and cleared here, at the top of the
        // iteration, before ANY path can skip past them.
        //
        // Both used to be consumed further down: `pauseAtNextCodeBehind` below
        // the conditional-group `continue`s and the skippable-step `continue`,
        // `pauseAtNextTool` inside the tool branch itself (so a run with no
        // tool step never cleared it at all). Neither survived contact with a
        // loop that has four ways out. A flag left set outlives the RUN, and
        // it lives on the SESSION — which stories/specs/run-and-compile-a-skill-step.md
        // then hands to another document via the picker. The result was an F11
        // in one test arming a `debugger;` in an unrelated run of another file;
        // with an inspector attached that freezes the whole server process.
        //
        // Clearing before the abort `break` is deliberate: a stopped run must
        // not leave the next one armed. `!signal?.aborted` still gates ACTING
        // on them, so a stop between steps disarms rather than descends.
        const wantCodeBehindStepInto = session.pauseAtNextCodeBehind;
        const wantToolStepInto = session.pauseAtNextTool;
        session.pauseAtNextCodeBehind = false;
        session.pauseAtNextTool = false;

        // Check abort BEFORE starting each step — the cheap, clean halt point
        // when a stop lands between steps. Mid-step aborts are also handled now
        // (issue 020): the run `signal` is threaded into every AI call so an
        // in-flight request cancels immediately, and the turn loop bails on
        // abort. A Playwright action already in flight still runs out its own
        // timeout (not cancelable), so worst-case residual latency is one
        // action timeout, not the old ~120s AI window.
        if (signal?.aborted) {
          overallStatus = 'aborted';
          logger.info(`Session "${sessionId}": run aborted by client at step ${i + 1}/${stepsTotal}`);
          break;
        }
        const originalStep = effectiveSteps[i]!;

        // ── A SKILL RETURNED: restore the caller's surface (§4.5) ─────────
        //
        // Ahead of the directive dispatch and the launch gate both, because
        // the surface it restores is what those two read. Skill frames only:
        // an inline section is inline by definition, and a section that
        // switches surface is how an author writes a desktop excursion once
        // and calls it by name.
        skillSurfaces.enter(
          skillFrameChain(expansionOrigins?.[i]?.frameId, expandedFrames),
          session.surface,
          restoreSurface,
        );

        // ── THE SURFACE SWITCH (SPEC-use-computer.md §4.4, §5.1) ──────────
        //
        // Rung 1 with the other bracket directives, and BEFORE the launch
        // gate below: a session whose first step is `[use computer]` must not
        // open a browser in order to be told it is switching away from one.
        // It never reaches a model, costs no tokens, and touches no page.
        //
        // Read off the AUTHORED line — `parseUseStep` normalises a
        // `[no-hooks]` prefix itself — so the surface a run drives is
        // readable from the file rather than assembled out of a substituted
        // value (§4.1).
        const useStep = parseUseStep(originalStep);
        if (useStep) {
          const frame = frameInfoFor(i);
          const frameSpreadForUse: { frame?: FrameInfo } = frame ? { frame } : {};
          if (hasControls) flushSkips(i);
          transitionToFrame(emittedFrameId(i));
          logger.step(
            session.totalStepsExecuted + 1,
            session.totalStepsExecuted + stepsTotal - i,
            originalStep,
          );
          emit({ type: 'step:start', line: sourceLineFor(i), ...frameSpreadForUse });

          let modeResult: StepResult;
          if (useStep.surface === 'computer') {
            const entered = await enterComputerMode({
              lockId: session.id,
              // The PROJECT's section, stored above from the bundle this batch
              // resolved — `runConfig.desktop` would be the server's.
              desktop: session.desktopConfig,
              state: surfaceStateOf(session),
              loadDesktopAdapter: this.loadDesktopAdapter,
              probeCapture: this.probeComputerCapture,
              ...(this.deps.computerLock && { lock: this.deps.computerLock }),
              // §15.4 — the route `session.aiClient` was pointed at for this
              // batch (see `effectiveAiRoute` above). Keyless — no key, or AI
              // forbidden by policy — skips the check: the first computer turn
              // already fails with the message that fits the reason.
              ai: runKeyless ? undefined : effectiveAiRoute,
              ...(this.deps.checkVisionRoute && { checkVisionRoute: this.deps.checkVisionRoute }),
            });
            modeResult = entered.ok
              ? modeStepResult(i + 1, originalStep, 'computer', entered.reentered)
              : {
                  index: i + 1,
                  instruction: originalStep,
                  status: 'failed',
                  stepKind: 'mode',
                  turns: [],
                  durationMs: 0,
                  retried: false,
                  error: entered.error,
                  aiExplanation: entered.error,
                };
          } else {
            const left = leaveComputerMode(
              surfaceStateOf(session),
              session.id,
              this.deps.computerLock,
            );
            modeResult = modeStepResult(i + 1, originalStep, 'browser', left.reentered);
          }

          fullStepResults.push(modeResult);
          results.push({
            step: originalStep,
            status: modeResult.status === 'failed' ? 'failed' : 'passed',
            actions: [],
            screenshot: '',
            reasoning: modeResult.aiExplanation ?? '',
            outputs: {},
          });
          session.conversationHistory.push(
            formatStepHistoryEntry(
              session.totalStepsExecuted + 1,
              originalStep,
              modeResult.status !== 'failed',
              '',
            ),
          );
          session.totalStepsExecuted++;
          session.tokenTracker.resetStep();

          if (modeResult.status === 'failed') {
            logger.error(`Session "${sessionId}" step ${i + 1} FAILED: ${modeResult.error}`);
            emit({
              type: 'step:fail',
              line: sourceLineFor(i),
              error: modeResult.error ?? 'the surface switch failed',
              stepKind: 'mode',
              ...frameSpreadForUse,
            });
            overallStatus = 'failed';
            errorInfo = { step: i, message: modeResult.error ?? 'the surface switch failed' };
            break;
          }

          emit({
            type: 'step:pass',
            line: sourceLineFor(i),
            output: modeMarkerText(useStep.surface),
            stepKind: 'mode',
            surface: useStep.surface,
            ...frameSpreadForUse,
          });
          stepsCompleted++;
          i = advanceAfter(i) - 1;
          continue;
        }

        // ── THE BROWSER LAUNCH (SPEC-use-computer.md §4.6) ────────────────
        //
        // The one place in this server that opens a browser for a session. It
        // is here, at the top of the step, because it must be ahead of every
        // page capture and every `executeStep` call in this loop — and there
        // are a dozen of those, down four branches.
        //
        // Deliberately NOT at session creation: TestBench posts steps one
        // request at a time, so at creation the server cannot know whether
        // step 1 is `[use computer]`. For every test written before computer
        // mode this fires on step 1 and nothing observable changes but the
        // timing of the launch.
        //
        // `session.surface` is always `browser` until the `[use …]` directive
        // lands, so today this always launches — a test that never reaches a
        // step (an empty batch) still never launches one.
        //
        // A failed launch is THIS STEP's failure, not a thrown batch: the
        // author sees "step 1 failed: <the launch error>" where they used to
        // see the same message from `POST /sessions`. `ensureLaunched` does not
        // cache the rejection, so a retry genuinely retries.
        //
        // Every `session.browserSession!` in the rest of this loop body reads
        // its non-null assertion from HERE: a browser-surface step cannot get
        // past this block without one, and a step that failed to launch one
        // `break`s out.
        if (session.surface === 'browser' && !session.browserTracker.hasActive()) {
          try {
            const launched = await session.browserTracker.ensureLaunched();
            session.browserSession = launched;
            // The MAIN page is the one the FIRST launch produced — `??=`, not
            // `=`, so a later relaunch (after `closeBrowser default`) cannot
            // re-point the video handle at a different page.
            session.mainPage ??= launched.page;
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            const frame = frameInfoFor(i);
            logger.error(`Session "${sessionId}" step ${i + 1}: browser launch failed — ${error}`);
            emit({ type: 'step:start', line: sourceLineFor(i), ...(frame && { frame }) });
            emit({ type: 'step:fail', line: sourceLineFor(i), error, ...(frame && { frame }) });
            results.push({
              step: originalStep,
              status: 'failed',
              actions: [],
              screenshot: '',
              reasoning: error,
              outputs: {},
            });
            fullStepResults.push({
              index: i + 1,
              instruction: originalStep,
              status: 'failed',
              turns: [],
              durationMs: 0,
              retried: false,
              error,
              aiExplanation: error,
            });
            overallStatus = 'failed';
            errorInfo = { step: i, message: error };
            break;
          }
        }

        /** Set when this step ended its flow: the last index the return skips,
         *  which the loop tail resumes after (stories/step-flow-control.md). */
        let flowControlJumpTo: number | null = null;
        /** …and whether that flow sat inside a control body, which is what
         *  lets a loop re-evaluate after a return ends one of its passes
         *  (`returnExit`, src/runner/control-flow.ts). */
        let flowControlEnclosed = false;
        // Baseline for this step's token attribution, read back below if the
        // step turns out to have healed a broken code-behind entry.
        tokensAtStepStart = session.tokenTracker.runTotal;

        // Apply env-data interpolation first (parse-time semantics: fixed for
        // the whole session), then runtime `{{...}}` parameter substitution.
        // `Set {{x}} to "…"` is read off the AUTHORED step and never
        // interpolated — `interpolate` would replace the TARGET with its own
        // value on a re-run (stories/variable-assignment.md §Locked). Its
        // template is resolved inside the branch, below.
        const setStep = parseSetStep(originalStep);
        // `If … then return` / `… then stop`, read off `originalStep` — before
        // the runtime `{{…}}` and `${…}` substitution two lines down
        // (stories/step-flow-control.md, decision 2). The claim is textual and
        // must be the same answer in every runner whatever a `{{…}}` in the
        // body holds; the model only judges the CONDITION, and only on the
        // conditional form.
        //
        // "Before interpolation" means that substitution and no other. This is
        // the EXPANDER's output, so a skill call's arguments and a looped
        // section's row values are already in it, and the same is true of the
        // CLI (`test.steps[i]`, whose own comment names it "the same form the
        // server has always held as `originalStep`") and the Runner UI. Three
        // runners, one text, one answer — which is the property decision 2 is
        // actually about. The narrower "the line exactly as typed" is
        // `expansionRawSteps[i]`, used further down for the REASON strings and
        // not for the claim, because the server's wire shape carries no
        // `rawSteps` for a looped section body (contract §3.2) and reading the
        // claim there would make the server disagree with the CLI for exactly
        // that shape.
        const flowControlClaim = setStep ? null : parseFlowControlStep(originalStep);
        // The unconditional form — a step whose WHOLE text is the tail, so
        // `Stop running the remaining steps` as much as `Return` — has no
        // condition to judge, so it is dispatched below beside `Set`: no model
        // call, no page snapshot, no cache entry (decision 3). The test is the
        // absent `body`, never the length of the line.
        const unconditionalFlowControl =
          flowControlClaim && flowControlClaim.body === undefined ? flowControlClaim : null;
        // The `… otherwise fail …` / `… otherwise continue` tail, off the same
        // AUTHORED text and for the same reason the claim is
        // (stories/step-failure-outcomes.md, decision 12). Leaf PROSE steps only:
        // a `Set` and a flow-control claim have grammars of their own, a `[tool:]`
        // step takes its own branch below, and a `### Section` / `[skill:]` call
        // line has already been replaced by its body steps. `originalStep` may
        // still carry a `[no-hooks]` prefix, which the parser normalises.
        const failureTail =
          setStep || flowControlClaim ? null : parseFailureTail(originalStep);
        // Decision 8's backstop. Steps POSTed straight to the Sessions API pass
        // no parse-time validator, so this is the only thing standing between
        // `If x then return otherwise continue` and a line that quietly gets
        // one of its two halves.
        const failureTailContradiction =
          setStep || flowControlClaim ? false : isFailureTailContradiction(originalStep);
        // NOT evaluated for a Set step. `interpolateEnvData` THROWS on an
        // unknown `${…}`, and this loop is `try { … } finally` with no catch,
        // so a bad reference inside a Set template escaped `executeRun`
        // entirely and surfaced as a server error rather than a `step:fail`.
        // Skipping it here is what makes `resolveSetTemplate`'s own per-step
        // refusal — which names the reference and fails just that step — the
        // reachable path.
        const envInterpolated =
          setStep || !envDataCtx ? originalStep : interpolateEnvData(originalStep, envDataCtx);
        // This loop interpolates EVERY step before it reaches the control
        // dispatch, guard lines included — so a `For each {{payment}} in
        // {{payments}}` header asks for the item name it is about to define.
        // `controlLineDefines` is what stops that being warned about
        // (src/parser/control-line.ts).
        const interpolated = setStep
          ? originalStep
          : interpolate(envInterpolated, resolvedParameters, controlLineDefines(originalStep));

        // Partial re-run guard: a leftover `{{__skill…}}` after interpolation
        // means this tail step needs an internal value that an earlier (skipped)
        // step in the skill produced. Those are namespaced per-expansion and
        // can't be seeded, so refuse with a clear message rather than send the
        // AI a step with a literal placeholder baked in. Can't trip on a normal
        // full run — every internal var is produced before it's consumed. The
        // common case (the failed step itself depends on a skipped step) trips
        // on the first tail step, so nothing runs before the refusal.
        // For a Set step only the TEMPLATE can depend on a skipped step: the
        // target is what this step writes, so it is unresolved by definition
        // and would trip the guard on every partial re-run
        // (stories/variable-assignment.md §What was measured).
        const partialRerunSubject = setStep
          ? interpolate(setStep.template, resolvedParameters)
          : interpolated;
        if (isPartialRerun && /\{\{__skill\w*\}\}/.test(partialRerunSubject)) {
          const frame = frameInfoFor(i);
          // Advice that serves every surface this refusal reaches: the
          // Variables-panel re-run, the Stop-debug selection, and a
          // skill-file single-step run/compile. The old wording said "Use
          // Continue", which only exists on the first of those.
          const message =
            `Can't re-run from this step on its own — it uses a value an earlier step ` +
            `in the skill produced, which can't be restored for a partial re-run. ` +
            `Start the run from the step that produces it, or re-run the whole skill.`;
          logger.info(`Session "${sessionId}": partial re-run refused at step ${i + 1}: ${message}`);
          emit({
            type: 'step:fail',
            line: effectiveSourceLines?.[i] ?? i + 1,
            error: message,
            ...(frame && { frame }),
          });
          // Mid-loop, so the compiler may exist and even hold earlier steps'
          // work; the refusal aborts the compile, and a failed
          // `compile:result` says why (see the anchor refusals above).
          await refuseOpenCompile(message);
          emit({ type: 'done', status: 'error', effectiveSettings: resolvedSettings.effective });
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

        // ── Decision 8's backstop ────────────────────────────────────
        //
        // `If x then return otherwise continue` asks to both end the flow and to
        // tolerate its own failure. Refused rather than resolved, with no model
        // call: there is nothing to judge about a line that means two things.
        //
        // HERE rather than beside the dispatch below, and the position is the
        // point: the `If …` shape of this contradiction is claimed by the
        // CONTROL-LINE grammar, so by the loop's dispatch the line has already
        // been sent to the judge as a decision and its tail queued as a body
        // step. A backstop downstream would refuse the tail — after spending the
        // model call the refusal exists to avoid, and naming a fragment.
        //
        // A file never gets this far: `validateControlFlow` (parser/markdown.ts)
        // refuses the same line by name with the same sentence. This is for the
        // path with no validator — steps POSTed straight to the Sessions API.
        // ── A dotted reference this pass cannot answer ───────────────
        //
        // `{{order.statuz}}` where the row has `status`
        // (docs/specs/SPEC-structured-table-reads.md §8.3). Refused here for
        // the same reason as the contradiction above: before the model call,
        // naming the properties the pass does hold, rather than sending six
        // literal braces to a judge that will report it as a step it could not
        // plan. Read off `originalStep`, since `interpolate` has already
        // replaced every reference it could answer.
        //
        // DOTTED only. An unresolved flat name is old ground and keeps its
        // warning — see `dottedReferenceError`.
        //
        // A GUARD line is skipped here and refused by `evaluateGuard` instead.
        // This loop resolves every step before the control dispatch, so it
        // would otherwise catch a guard's condition on the step path and file
        // a `step:fail` where the CLI and the Electron adapter — which
        // dispatch the guard first — file a failed GUARD row. One refusal, one
        // shape, in the module all three share.
        //
        // Masked with `secretsNow` — which counts a section row's frame inputs
        // as well as the parameter map — because the refusal is written from
        // the run's own values (the properties the row holds, the keys the
        // loop dropped) and goes out on the `step:fail` wire payload as well
        // as into the run log and the report.
        const dottedRefError =
          setStep || (hasControls && controls[i])
            ? undefined
            : dottedReferenceError(
                originalStep,
                resolvedParameters,
                (item) => forEachPassOf(controls, controlState, item),
                (text) => redact(text, secretsNow()),
              );
        if (dottedRefError) {
          const frame = frameInfoFor(i);
          logger.error(`Session "${sessionId}" step ${i + 1}: ${dottedRefError}`);
          emit({
            type: 'step:start',
            line: sourceLineFor(i),
            ...(frame && { frame }),
          });
          emit({
            type: 'step:fail',
            line: sourceLineFor(i),
            error: dottedRefError,
            ...(frame && { frame }),
          });
          results.push({
            step: originalStep,
            status: 'failed',
            actions: [],
            screenshot: '',
            reasoning: dottedRefError,
            outputs: {},
          });
          fullStepResults.push({
            index: i + 1,
            instruction: originalStep,
            status: 'failed',
            turns: [],
            durationMs: 0,
            retried: false,
            error: dottedRefError,
            aiExplanation: dottedRefError,
          });
          overallStatus = 'failed';
          errorInfo = { step: i, message: dottedRefError };
          break;
        }

        if (failureTailContradiction) {
          const error = failureTailContradictionError(originalStep);
          const frame = frameInfoFor(i);
          logger.error(`Session "${sessionId}" step ${i + 1}: ${error}`);
          emit({
            type: 'step:start',
            line: sourceLineFor(i),
            ...(frame && { frame }),
          });
          emit({
            type: 'step:fail',
            line: sourceLineFor(i),
            error,
            ...(frame && { frame }),
          });
          results.push({
            step: originalStep,
            status: 'failed',
            actions: [],
            screenshot: '',
            reasoning: error,
            outputs: {},
          });
          fullStepResults.push({
            index: i + 1,
            instruction: originalStep,
            status: 'failed',
            turns: [],
            durationMs: 0,
            retried: false,
            error,
            aiExplanation: error,
          });
          overallStatus = 'failed';
          errorInfo = { step: i, message: error };
          break;
        }

        // Check if this step is part of a conditional group
        const group = stepGroups.get(i);
        if (
          group &&
          i === group.conditionalSteps[0]!.index &&
          session.surface === 'computer'
        ) {
          // A watch group POLLS a page until one of its outcomes matches, and
          // there is no page here — §5.6 gives the computer surface the
          // `If … then` judge and nothing else. Refused by name rather than
          // run against a `browserSession` that may not exist.
          const error =
            'a conditional watch group needs the page surface; put it before ' +
            '`[use computer]`, or write the decision as an `If … then` line';
          logger.error(`Session "${sessionId}" step ${i + 1}: ${error}`);
          emit({ type: 'step:start', line: sourceLineFor(i) });
          emit({ type: 'step:fail', line: sourceLineFor(i), error, surface: 'computer' });
          results.push({
            step: originalStep,
            status: 'failed',
            actions: [],
            screenshot: '',
            reasoning: error,
            outputs: {},
          });
          fullStepResults.push({
            index: i + 1,
            instruction: originalStep,
            status: 'failed',
            surface: 'computer',
            turns: [],
            durationMs: 0,
            retried: false,
            error,
            aiExplanation: error,
          });
          overallStatus = 'failed';
          errorInfo = { step: i, message: error };
          break;
        }
        if (group && i === group.conditionalSteps[0]!.index) {
          logger.info(`Session "${sessionId}": conditional group at step ${i + 1}`);

          // Anything an earlier decision skipped, before this group says
          // anything — every other result-producing path in this loop flushes
          // first, so a chain's untaken half stays in file order on the wire.
          //
          // No loop marker is stamped here, unlike the CLI's twin of this
          // block: the server records no `fullStepResults` row for a branched
          // step at all (only an MCP-facing `results` entry, which has no
          // `loop` field), so there is nothing here to band.
          if (hasControls) flushSkips(i);

          let branchedResults: StepResult[];
          try {
            branchedResults = await executeBranchedStep(group, stepsTotal, {
              page: session.browserSession!.pageTracker.getActive(),
              // `runConfig`, not `this.config` — see the resolution above.
              config: runConfig,
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
              pageTracker: session.browserSession!.pageTracker,
              browserTracker: session.browserTracker,
              // The poller reads the page on every poll and sends the snapshot
              // to the model, so it needs the same secret set the step prompt
              // and the guard get — `secretsFor` consults `envData` only when
              // it is there, so without this a `${env.PASSWORD}` typed into a
              // text-typed field went to the model in full on this path while
              // every ordinary step showed `***` (review 4, finding 3). Same
              // spread as the `evaluateGuard` call below.
              ...(envDataCtx && { envData: envDataCtx }),
              ...(unmaskNames.size > 0 && { unmask: unmaskNames }),
              // The branch's matched step runs through `executeStep` like any
              // other, so it shares this run's structure memo (§7.10).
              structureMemo,
              ...(signal && { signal }),
            });
          } catch (err) {
            // An aborted branch throws (cancelled AI call / abort check in the
            // poll loop). Treat it as a clean stop, not a server error — the
            // for-loop has no catch, so without this the AbortError would
            // escape to the api-server and surface as "Server error". See
            // issues/020.
            if (signal?.aborted) {
              overallStatus = 'aborted';
              logger.info(`Session "${sessionId}": run aborted by client during branched step ${i + 1}/${stepsTotal}`);
              recordInterruptedStep(i + 1, originalStep);
              break;
            }
            throw err;
          }

          // Post-branch abort check. An abort landing during the *matched
          // branch's* inner executeStep doesn't throw — executeStep swallows it
          // and returns a 'failed' result. Without this, the results loop below
          // would mark the run 'failed' instead of 'aborted'. Mirror the
          // normal-path post-step check: end cleanly before processing results.
          // See issues/020.
          if (signal?.aborted) {
            overallStatus = 'aborted';
            logger.info(`Session "${sessionId}": run aborted by client during branched step ${i + 1}/${stepsTotal}`);
            recordInterruptedStep(i + 1, originalStep);
            break;
          }

          let branchFailed = false;
          for (const result of branchedResults) {
            const screenshotValue = result.screenshotBase64
              ? `data:image/png;base64,${result.screenshotBase64}`
              : '';
            // Reported as recorded. The narrowing that used to sit here —
            // `'skipped' ? 'passed'` — predates `StepResultResponse` gaining
            // `'skipped'` (decision 9), and it greened the branched path's own
            // untaken members: a conditional group records every unmatched
            // outcome `skipped` ("outcome N matched instead"), which is the
            // same shape a chain's untaken half has and must read the same way.
            const resultStatus: StepResultResponse['status'] = result.status;

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
              currentUrl = session.browserSession!.pageTracker.getActive().url();
            } catch { /* ignore */ }

            session.conversationHistory.push(
              formatStepHistoryEntry(
                session.totalStepsExecuted + 1,
                redact(result.instruction, secretsNow()),
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

          // Skip past all steps in this group, then let control flow have its
          // say: the continuation step can be a loop body's last step.
          i = advanceAfter(group.continuationStep.index) - 1;

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
        // The EMITTED id, so a loop pass transitions into its own clone of the
        // tail's frames and out of the previous pass's — one `frame:pop` /
        // `frame:push` pair per pass, from the machinery that already does it.
        const stepFrameId = emittedFrameId(i);
        transitionToFrame(stepFrameId);
        const frameForStep = frameInfoFor(i);
        const frameSpread: { frame?: FrameInfo } = frameForStep ? { frame: frameForStep } : {};

        /**
         * Which tab this step is in, resolved at emit time (§11).
         *
         * Read fresh for each of `step:start` / `step:pass` / `step:fail`
         * rather than once per step: a step that switches tabs must report
         * the tab it *ended* in, which is the whole diagnostic. Cheap after
         * the first call — the target id is cached on the tracked page, so
         * this is a URL read plus a bounded `title()`.
         */
        const tabSpread = async (): Promise<{ tab?: TabInfo }> => {
          try {
            const tab = await session.browserSession?.pageTracker.describeActiveTab();
            return tab ? { tab } : {};
          } catch {
            // Never let a diagnostic field fail a step's event.
            return {};
          }
        };

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
        // Test-file breakpoints DO reach the map — a section body line lives
        // in the test file and the client's `trimAtBreakpoint` cannot see it —
        // and are skipped per-step below for root-frame steps only, which are
        // the ones the client really did trim at.
        if (
          breakpointSetsByUri.size > 0 &&
          !consumedBreakpoints.has(i) &&
          frameForStep?.uri &&
          !signal?.aborted
        ) {
          const stepUriBps = breakpointSetsByUri.get(frameForStep.uri);
          const stepLine = sourceLineFor(i);
          // Root-frame steps in the test file are the client's responsibility:
          // it already trimmed the batch at those breakpoints before sending,
          // so pausing here as well would stop twice on one line. Every other
          // frame — a skill body, or a section body that also lives in the
          // test file — is invisible to that trim and must pause here.
          const clientAlreadyTrimmed =
            frameForStep.kind === 'test' && frameForStep.uri === request.testFilePath;
          if (!clientAlreadyTrimmed && stepUriBps?.has(stepLine)) {
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

        // ── Control flow: the guard decides, the planner says what follows ──
        //
        // After the breakpoint check, so a breakpoint on a guard line pauses
        // BEFORE the decision. Before everything else: a guard is not a page
        // step — no cache, no code-behind, no compile, no `executeStep`
        // (stories/control-flow.md §"What is deliberately unchanged").
        //
        // A breakpoint pauses on the guard's first visit whatever that visit
        // asks (`consumedBreakpoints` allows one pause per step index per
        // pass — `rearmLoopBreakpoints` is what makes it per pass), so a
        // `Repeat` — whose first visit asks nobody, its body running before
        // there is anything to decide — pauses on a visit that emits no
        // `step:start`. That is fine and deliberate: `step:awaiting` is its own
        // paint, cleared by the next `step:start` from anywhere, and the next
        // one comes from the body's first step. Nothing is left stuck.
        const controlRecord = hasControls ? (controls[i] ?? null) : null;
        if (controlRecord) {
          // Anything an earlier decision skipped, before this line starts.
          flushSkips(i);
          // Only a visit that will produce a guard row opens one. A visit that
          // asks nobody records nothing and so emits no `step:pass` / `step:fail`
          // either, and a `step:start` with nothing to close it left the line
          // painted `running` for the rest of the run — a `For each`'s revisits
          // are all of that shape, the exhausted-list one included
          // (stories/control-flow.md §"What the live run found").
          const evaluates = guardVisitEvaluates(controls, i, controlState);
          if (evaluates) {
            emit({ type: 'step:start', line: sourceLineFor(i), ...frameSpread });
            logger.step(
              session.totalStepsExecuted + 1,
              session.totalStepsExecuted + stepsTotal - i,
              redact(originalStep, secretsNow()),
            );
          }

          let evaluation;
          try {
            evaluation = await evaluateGuard({
              controls,
              index: i,
              state: controlState,
              resolvedParameters,
              // A locally decided condition's reasoning carries VALUES — it is
              // built from the substituted text — and goes out on `step:pass`
              // as `output` as well as into the run log. `secretsNow` rather
              // than the parameter map alone, because a looped section's row
              // arrives as frame inputs.
              redact: (text) => redact(text, secretsNow()),
              executorOptions: {
                // Absent in fact on the computer surface, where the run may
                // have launched no browser at all (§4.6) — see
                // `StepExecutorOptions.page`. `evaluateConditions` branches on
                // `computer` before it reads either of these (§5.6).
                page: session.browserSession?.pageTracker.getActive() as
                  StepExecutorOptions['page'],
                config: runConfig,
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
                ...(session.browserSession && {
                  pageTracker: session.browserSession.pageTracker,
                }),
                browserTracker: session.browserTracker,
                // The condition reaches the model AUTHORED, beside a `## Values`
                // block, so the judge needs the same env context a step gets.
                ...(envDataCtx && { envData: envDataCtx }),
                ...(unmaskNames.size > 0 && { unmask: unmaskNames }),
                nonInteractive: true,
                ...(signal && { signal }),
                // §5.6 — judged from a capture of the screen, with no DOM.
                ...(session.surface === 'computer' && session.computerAdapter
                  ? { computer: computerContextFor(session.desktopConfig, session.computerAdapter) }
                  : {}),
              },
            });
          } catch (err) {
            // An aborted judge throws, exactly as an aborted branched step
            // does. A stop is a stop, not a server error (issues/020).
            if (signal?.aborted) {
              overallStatus = 'aborted';
              logger.info(
                `Session "${sessionId}": run aborted by client during guard ${i + 1}/${stepsTotal}`,
              );
              recordInterruptedStep(i + 1, originalStep);
              break;
            }
            throw err;
          }
          const { plan } = evaluation;

          // A pass is starting: clone its frames, bind its item, open its band.
          let marker;
          if (plan.pass && isLoopRecord(controlRecord)) {
            marker = loops.beginPass(i, controlRecord, plan.pass);
            // ...and re-arm the breakpoints the last pass consumed, so a body
            // line's breakpoint fires on this pass too.
            rearmLoopBreakpoints(i, controlRecord);
            cloneFramesForPass(i, controlRecord, plan.pass);
            if (plan.pass.bindings) {
              // Into the live map, which is what makes `{{account}}` resolve in
              // the body. It keeps its last value after the loop — there is one
              // map, and the story says so rather than pretending otherwise.
              // `applyPassBindings` clears the last pass's dotted keys first,
              // so a row that omits a property does not inherit the previous
              // row's (control-runtime.ts).
              applyPassBindings(resolvedParameters, plan.pass.bindings);
            }
          }
          // The loop ended: every `(n/?)` marker it issued becomes `(n/count)`,
          // in place, while the results are still in memory.
          if (plan.loopEnded) loops.endLoop(plan.loopEnded);

          const rows = guardRows(controlRecord, i, evaluation);
          const reason = skipReasonFor(controlRecord, plan);
          for (const k of rows.skip) skipReasons.set(k, reason);
          skipQueue.add(rows.skip);

          if (rows.guard) {
            flushSkips(rows.guard.index);
            const guardLine = sourceLineFor(rows.guard.index);
            const guardFrame = frameInfoFor(rows.guard.index);
            const guardText = effectiveSteps[rows.guard.index] ?? originalStep;
            const result = guardResult({
              index: rows.guard.index + 1,
              instruction: redact(guardText, secretsNow()),
              status: rows.guard.status,
              durationMs: evaluation.durationMs,
              reasoning: evaluation.reasoning,
              error: evaluation.error,
              aiInteractions: evaluation.aiInteractions,
              loop: marker,
            });
            const guardSkill = outermostSkillName(
              expansionOrigins?.[rows.guard.index]?.frameId,
              expansionFrames,
            );
            const guardSection = outermostSectionName(
              expansionOrigins?.[rows.guard.index]?.frameId,
              expansionFrames,
            );
            if (guardSkill) result.sourceSkill = guardSkill;
            if (guardSection) result.sourceSection = guardSection;
            fullStepResults.push(result);
            results.push({
              step: guardText,
              // Reported as recorded — `'skipped'` included. `StepResultResponse`
              // gained that value with `stories/step-flow-control.md` decision 9,
              // and this row is exactly what it is for: an `If` chain in which
              // nothing held and there is no `Otherwise` records the guard that
              // was ASKED as skipped, and reporting it `passed` here would put a
              // green row in the response body beside the `—` the report renders
              // for the same guard.
              status: rows.guard.status,
              actions: [],
              screenshot: '',
              reasoning: evaluation.reasoning ?? evaluation.error ?? '',
              outputs: {},
            });
            if (rows.guard.status === 'failed') {
              emit({
                type: 'step:fail',
                line: guardLine,
                error: evaluation.error ?? 'The decision could not be made',
                ...(guardFrame && { frame: guardFrame }),
              });
            } else {
              // The FOURTH producer of `step:pass` + `output: 'skipped'`, and
              // the commonest conditional shape there is: `If X, then Y` with
              // no `Otherwise` and a condition that did not hold. It carries
              // the same two additive fields `emitSkippedStep` does, for the
              // same reason — without `skipKind` the MCP fold reads the absent
              // field as `'unattended'` (the compatibility default) and ends
              // the run telling an agent that steps "need a human", which
              // nothing on this page does. `reason` is the sentence the report
              // row already carries, so the ◌ hover and the log lines can say
              // why rather than only that something was skipped.
              const guardSkipped = rows.guard.status === 'skipped';
              emit({
                type: 'step:pass',
                line: guardLine,
                output: guardSkipped ? 'skipped' : (evaluation.reasoning ?? 'decided'),
                ...(guardSkipped && { reason, skipKind: 'not-taken' as const }),
                ...(guardFrame && { frame: guardFrame }),
              });
              stepsCompleted++;
            }
            // The SELECTED member's line, plus a `did not hold` line for each
            // alternative the judge ruled out. `originalStep` is the head of
            // the chain — the line the question was asked from, not
            // necessarily the one that held.
            session.conversationHistory.push(
              ...guardHistoryLines({
                controls,
                index: i,
                rows,
                plan,
                text: (k) => redact(effectiveSteps[k] ?? originalStep, secretsNow()),
              }),
            );
            session.totalStepsExecuted++;
          }

          session.tokenTracker.resetStep();

          if (evaluation.error) {
            overallStatus = 'failed';
            errorInfo = { step: i, message: evaluation.error };
            logger.error(`Session "${sessionId}" step ${i + 1} FAILED: ${evaluation.error}`);
            // The band reports the passes the loop actually made rather than
            // staying open at `?`.
            if (isLoopRecord(controlRecord)) {
              loops.abandon(i, controlState.passes.get(i) ?? 0);
            }
            break;
          }

          // `i++` is about to run, so aim one short of where the plan points.
          i = plan.next - 1;
          continue;
        }

        // Check for skippable steps ([input:] and [interactive])
        if (isSkippableStep(interpolated)) {
          logger.info(`Session "${sessionId}": skipping step ${i + 1} (input/interactive not supported in API mode)`);
          emit({ type: 'step:start', line: sourceLineFor(i), ...frameSpread });
          // Surface the skip to the user, not just to the server log. For a
          // MAIN-FLOW step this branch is unreachable — the client splits the
          // batch before an `[input:]` and prompts — but a step inside a
          // skill or section body is invisible to that split, so it lands
          // here and the run finishes green having quietly not done it.
          // Reporting green for work that was skipped is the failure
          // direction worth being loud about.
          if (frameForStep && frameForStep.kind !== 'test') {
            emit({
              type: 'output',
              kind: 'warn',
              msg:
                `Step "${originalStep}" at ${frameForStep.uri}:${sourceLineFor(i)} was SKIPPED: ` +
                `[input:] and [interactive] steps can't be prompted for inside a ` +
                `${frameForStep.kind} body, which the client cannot split a batch on. ` +
                `Move it to the main flow if it needs a value.`,
            });
          }
          results.push({
            step: originalStep,
            status: 'passed',
            actions: [],
            screenshot: '',
            reasoning: UNATTENDED_SKIP_REASON,
            outputs: {},
          });
          // `skipKind: 'unattended'` is what makes this the skip that NEEDS a
          // human, told apart from an untaken branch that needs nobody
          // (runner-core/src/protocol.ts). It is also what an older server
          // means when it sends neither field, so the default matches.
          emit({
            type: 'step:pass',
            line: sourceLineFor(i),
            output: 'skipped',
            reason: UNATTENDED_SKIP_REASON,
            skipKind: 'unattended',
            ...frameSpread,
          });
          stepsCompleted++;
          session.totalStepsExecuted++;
          i = advanceAfter(i) - 1;
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

        // The one log line that ignores the log level — so the one place the
        // resolved password would always print. Masked; the step itself runs
        // with the real value.
        logger.step(
          session.totalStepsExecuted + 1,
          session.totalStepsExecuted + stepsTotal - i,
          redact(stepInstruction, secretsNow()),
        );

        // Untaken branches recorded before this step starts, so the report and
        // the event stream both read in the order the file is written in.
        if (hasControls) flushSkips(i);

        emit({ type: 'step:start', line: sourceLineFor(i), ...frameSpread, ...(await tabSpread()) });

        // Code-behind step-into (stories/codebehind-debugging.md). The flag was
        // already consumed at the top of the iteration — F11 means "descend
        // into *this* step", and a flag that lingered would ambush a later one.
        // Only the non-tool branch can act on it.
        const codeBehindStepInto = wantCodeBehindStepInto && !signal?.aborted;

        // Tool-step branch — when the step is a `[tool: ...]` invocation
        // AND we have a loaded catalogue, dispatch through `executeToolStep`
        // (the same code path the CLI runner uses) and shape the outcome
        // into a `StepResult` so the rest of the loop is unchanged. Without
        // a catalogue, fall through to `executeStep` and let the AI loop
        // see the raw `[tool: ...]` text (legacy behaviour).
        const toolCall =
          setStep || unconditionalFlowControl
            ? null
            : toolCatalogue
              ? parseToolCall(originalStep)
              : null;
        // …except on the computer surface, where that legacy fall-through is
        // refused (SPEC-use-computer.md §5.4): a model handed `[tool: x]` as
        // prose acts it out on the real desktop. Same for a raw `[skill: x]`,
        // which only survives to here when nothing expanded it. Computed for
        // the steps the branches below would otherwise send to
        // `executeComputerStep`, and nothing else.
        const undispatchedDirective =
          session.surface === 'computer' && !toolCall && !setStep && !unconditionalFlowControl
            ? undispatchedDirectiveError(originalStep, {
                toolsLoaded: toolCatalogue !== undefined,
                skillsDirSupplied: !!request.skillsDir,
              })
            : null;
        let stepResult: StepResult;
        try {
          if (unconditionalFlowControl && unconditionalFlowControl.verb === 'fail') {
            // `Fail the test with error "…"` as a whole step: no condition, so no
            // model call and no page snapshot — dispatched beside `Return` and
            // `Set` (stories/step-failure-outcomes.md, decisions 1 and 3). The
            // message rode through the interpolation above and is masked here,
            // where it first becomes what the wire, report and log carry.
            stepResult = deliberateFailResult(
              i + 1,
              interpolated,
              redact(
                deliberateFailError(unconditionalFlowControl, interpolated),
                secretsNow(),
              ),
            );
            // The shot a step that failed under the executor gets, on the same
            // config switch: a deliberate failure with no screenshot where every
            // other failure has one reads as a missing capture.
            if (runConfig.execution.screenshotOnFailure) {
              try {
                const shot = await captureScreenshot(
                  session.browserSession!.pageTracker.getActive(),
                  runConfig.browser.fullPageScreenshots,
                );
                if (shot?.base64) stepResult.screenshotBase64 = shot.base64;
              } catch {
                // A missing screenshot must not turn the author's failure into
                // a server error.
              }
            }
          } else if (unconditionalFlowControl) {
            // `Return` / `Stop` as a whole step: nothing to judge, so nothing
            // to ask the model (stories/step-flow-control.md, decision 3). Its
            // explanation is the bare phrase — `Returned from "Sign in"` or
            // `Ended the run` — because there is no model detail to append.
            stepResult = {
              index: i + 1,
              instruction: interpolated,
              status: 'passed',
              turns: [],
              durationMs: 0,
              retried: false,
              aiExplanation: flowControlExplanation(
                frameLabel(expansionOrigins ?? undefined, expandedFrames, i),
              ),
              // `isReturnClaim` narrows the union: a `flowControl` record means
              // "ended the flow as a PASS", so a `fail` claim must never produce
              // one — it took the branch above (decision 1).
              ...(isReturnClaim(unconditionalFlowControl) && {
                flowControl: { kind: 'return' as const, verb: unconditionalFlowControl.verb },
              }),
            };
          } else if (setStep) {
            // Assignment: no model, no page, no cache. The capture event is
            // emitted here rather than by the common sweep below so its
            // `source` can say `assignment` — the sweep labels everything it
            // finds `capture` (stories/variable-assignment.md §Locked).
            const outcome = runSetStep(
              setStep,
              interpolated,
              i + 1,
              resolvedParameters,
              envDataCtx,
            );
            stepResult = outcome.result;
            if (outcome.assigned) {
              const { name, value } = outcome.assigned;
              // `defineProperty` for the same reason `runSetStep` uses it:
              // `session.outputs` is a plain `{}`, so `outputs['__proto__'] =`
              // creates no own key — the value would resolve inside this batch
              // and then silently vanish from the HTTP outputs map and from
              // the seed the NEXT batch builds. The guard was one line short
              // of the write it was meant to protect.
              Object.defineProperty(session.outputs, name, {
                value,
                writable: true,
                enumerable: true,
                configurable: true,
              });
              // First-write-wins, like every other write site here. The field
              // documents itself as keeping "the variable's original identity
              // rather than hiding it behind the latest source", and writing
              // unconditionally broke that: a `## Parameters` value a Set
              // later rewrote moved out of the Parameters section of the
              // clients that group by this.
              if (!(name in session.outputSources)) {
                session.outputSources[name] = 'assignment';
              }
              emit({
                type: 'capture',
                line: sourceLineFor(i),
                name,
                value,
                source: 'assignment',
              });
            }
          } else if (toolCall && toolCatalogue) {
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
            if (wantToolStepInto && !signal?.aborted) {
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
              // Park on the ack; arm the cooperative pause only when the
              // ack actually arrived (vs. abort) — see awaitDebuggerAck.
              pauseBeforeRun = await this.awaitDebuggerAck(session, signal);
            }
            const startedAt = Date.now();
            const outcome = await executeToolStep(toolCall, {
              // `?.`, not `!`: a `[tool:]` step is dispatched on either
              // surface (§5.5 changes only how a PROSE step is answered), and
              // a computer-mode run may have launched no browser at all
              // (§4.6). A tool that never touches the page — the fixture
              // `assert_file_exists` of §7, for one — then works there; a tool
              // that does gets `undefined` and says so in its own words,
              // rather than this line throwing a TypeError three frames away
              // from the cause.
              page: session.browserSession?.pageTracker.getActive() as Page,
              context: session.browserSession?.context as BrowserContext,
              browser: session.browserSession?.browser as Browser,
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
          } else if (undispatchedDirective !== null) {
            // A `[tool:]` / `[skill:]` line nothing above dispatched, on the
            // computer surface: fail it here, before any capture or model call.
            logger.error(undispatchedDirective);
            stepResult = undispatchedDirectiveResult(
              effectiveSourceLines?.[i] ?? i + 1,
              originalStep,
              undispatchedDirective,
            );
          } else if (session.surface === 'computer' && session.computerAdapter) {
            // ── THE COMPUTER SURFACE (SPEC-use-computer.md §5.5) ──────────
            //
            // Last of the dispatches, and that position is the rule: `Set`, a
            // `[tool:]` call, a control line and an `If … then return` claim
            // mean the same thing on either surface and took their own
            // branches above. What changes here is only how a PROSE step is
            // answered — from a capture of the screen instead of a DOM.
            //
            // No `stepCache` and no code-behind binding: a cached coordinate
            // has nothing to validate against at replay (§5.5, §10.4), and a
            // recorded one is not portable to another machine (§9).
            stepResult = await executeComputerStep(
              effectiveSourceLines?.[i] ?? i + 1,
              stepsTotal,
              stepInstruction,
              {
                // No page on this surface, and possibly no browser in the
                // session at all (§4.6) — see `StepExecutorOptions.page`.
                page: undefined as never,
                config: runConfig,
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
                browserTracker: session.browserTracker,
                ...(envDataCtx && { envData: envDataCtx }),
                ...(unmaskNames.size > 0 && { unmask: unmaskNames }),
                nonInteractive: true,
                ...(flowControlClaim && { flowControlClaim }),
                ...(failureTail && { failureTail }),
                ...(signal && { signal }),
                computer: computerContextFor(session.desktopConfig, session.computerAdapter),
              },
              originalStep,
            );
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
            // Code-behind step-into: only a step with a bound entry pauses.
            // Emit the awaiting event, park for the debugger-attach ack,
            // then arm the cooperative `debugger;` that sits immediately
            // before the entry's `run()` (src/codebehind/execute.ts). The
            // binding names the canonical `.steps.ts` — where the user's
            // breakpoints and editor live — even on a compile replay, though
            // compile runs never send the flag.
            let codeBehindPause = false;
            const debugBinding = codeBehindStepInto ? codeBehind.bindingFor(i) : undefined;
            // `ai: true` must be excluded, matching `executeStep`'s own gate
            // (`binding?.entry && binding.entry.ai !== true`, step-executor.ts).
            // Without it the server announced `codebehind:awaiting-debugger`,
            // blocked for the ack, and threaded `codeBehindPauseBeforeRun`
            // through — and then the executor skipped the entry, so no
            // `debugger;` ever ran. The story's Limits section promises the
            // opposite ("F11 degrades to a plain step pause"), and these are
            // not rare: compile writes off every step it could not compile as
            // an `ai: true` entry, so real `.steps.ts` files are full of them.
            if (debugBinding?.entry && debugBinding.entry.ai !== true) {
              emit({
                type: 'codebehind:awaiting-debugger',
                file: debugBinding.file,
                line: sourceLineFor(i),
                ...frameSpread,
              });
              codeBehindPause = await this.awaitDebuggerAck(session, signal);
            }
            stepResult = await executeStep(
              stepSourceLine,
              stepsTotal,
              stepInstruction,
              {
                page: session.browserSession!.pageTracker.getActive(),
                // `runConfig`, not `this.config` — see the resolution above.
                config: runConfig,
                aiClient: session.aiClient,
                contextContent: session.contextContent,
                testName: `session:${sessionId}`,
                ...(session.sessionConfig.baseUrl !== undefined && {
                  baseUrl: session.sessionConfig.baseUrl,
                }),
                conversationHistory: [...session.conversationHistory],
                apiResponseStore: session.apiResponseStore,
                csrfTokens: session.csrfTokens,
                // Where an "Upload file ..." step's path resolves from: the
                // folder of the test file the client sent, fenced by the
                // project root the bundle already walked to. A request without
                // a testFilePath (Flick, and any client that omits it) gets no
                // base, so a relative upload path fails with a message saying
                // exactly that rather than resolving against the server's cwd.
                uploadPaths: {
                  ...(request.testFilePath !== undefined && {
                    baseDir: dirname(request.testFilePath),
                  }),
                  projectRoot: projectBundle.projectRoot,
                },
                resolvedParameters,
                pageTracker: session.browserSession!.pageTracker,
                browserTracker: session.browserTracker,
                ...(stepCache && { stepCache }),
                structureMemo,
                cacheEnabled:
                  cacheEnabledForRequest &&
                  !!stepCache &&
                  // See `isSubsetBatch`: a non-root frame's key is not stable
                  // across batches, so neither read nor write is safe here.
                  !(isSubsetBatch && (expansionOrigins?.[i]?.frameId ?? '') !== '') &&
                  // A step inside a loop body runs several times with several
                  // values, and the cache holds one plan per line
                  // (stories/control-flow.md, decision 12).
                  !loopBodySteps.has(i),
                cacheKey: stepCacheKey,
                ...(codeBehind.bindingFor(i) && { codeBehind: codeBehind.bindingFor(i)! }),
                ...(codeBehindPause && { codeBehindPauseBeforeRun: true }),
                // What `${data.url}` in the step text was resolved against,
                // so the entry's `step.getVar('data.url')` reads the same value.
                ...(envDataCtx && { envData: envDataCtx }),
                ...(cb?.strict !== undefined && { codeBehindStrict: cb.strict }),
                // A broken entry fails instead of healing when this run has no
                // AI (stories/keyless-replay-and-gateway-env.md §Part B) —
                // either because the machine has no key or because the run
                // forbids AI (stories/run-settings.md §9). See `runKeyless`:
                // the key half is read off `desiredAi`, NOT `runConfig.ai`,
                // which carries only the server's startup key.
                ...(runKeyless && { keyless: true }),
                // Which explanation the skipped step carries. Absent means
                // 'no-key', so nothing changes for a run that simply has no key.
                ...(runKeyless && aiPolicyOff && { keylessReason: 'policy' as const }),
                ...(captureStepContext && { captureStepContext: true }),
                // No interactive console attached to a server-driven run —
                // an AI clarification prompt must fail the step fast rather
                // than block on stdin and hang the stream. See issues/014.
                nonInteractive: true,
                // The test's `## Config: unmask:` list — names `isSecretName`
                // matches but this test says are not secrets
                // (stories/placeholder-preserving-actions.md, decision 2).
                ...(unmaskNames.size > 0 && { unmask: unmaskNames }),
                // The CONDITIONAL form only — the unconditional one took its
                // own branch above and never reaches here. Present, this is
                // what lets the model's `return` action end the step; absent,
                // the action is refused with RETURN_NOT_CLAIMED and the model
                // is told why on its next turn (decision 2). It also turns on
                // the executor's settle gate before the judgement (decision 6).
                // Since stories/step-failure-outcomes.md decision 1 the same
                // field carries a conditional `fail` claim, which is what lets
                // a `fail` action through.
                ...(flowControlClaim && { flowControlClaim }),
                // This step's `… otherwise …` tail, read at one seam over a
                // step that has finally failed (decision 4). Never both: the
                // tail is null whenever a claim was read off the line.
                ...(failureTail && { failureTail }),
                // Run abort signal — cancels in-flight AI calls and stops the
                // step's turn loop the instant the client stops. See issues/020.
                ...(signal && { signal }),
              },
              // The step as WRITTEN — `{{}}` and `${}` intact, skill renames
              // applied. The server has held this form all along and threw it
              // away one line before the model saw it; the executor shows it
              // beside a `## Values` block and substitutes at act time
              // (stories/placeholder-preserving-actions.md, decision 1).
              originalStep,
            );
          }
        } catch (err) {
          // Aborted (client "stop") — a throw escaping the step (e.g. a tool
          // step interrupted) when the run was stopped. Treat as a clean abort,
          // not an error: no error event, no error screenshot. The post-loop
          // `done` carries status 'aborted'. See issues/020.
          if (signal?.aborted) {
            overallStatus = 'aborted';
            logger.info(`Session "${sessionId}": run aborted by client during step ${i + 1}/${stepsTotal}`);
            recordInterruptedStep(i + 1, originalStep);
            break;
          }

          // Unexpected error during step execution
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Session "${sessionId}" step ${i + 1} error: ${message}`);

          // Capture screenshot on error if possible
          let errorScreenshot = '';
          try {
            const shot = await captureScreenshot(
              session.browserSession!.pageTracker.getActive(),
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

        // Post-step abort check. `executeStep` swallows a cancelled AI call's
        // AbortError and returns a 'failed' StepResult, so without this the run
        // would fall into the failed-step branch below and report 'failed'
        // instead of 'aborted'. Catch it here — before the pass/fail handling —
        // and end the run cleanly: no step:fail, no failure screenshot. The
        // between-step check at the top of the loop only fires on the *next*
        // iteration, which a failed-step `break` would skip. See issues/020.
        if (signal?.aborted) {
          overallStatus = 'aborted';
          logger.info(`Session "${sessionId}": run aborted by client during step ${i + 1}/${stepsTotal}`);
          recordInterruptedStep(i + 1, originalStep, stepResult);
          break;
        }

        // Name the flow the step left. `executeStep` produced the model's own
        // account of why the condition held and nothing more — it holds no
        // expansion, so it cannot know whether this was "Sign in" or the whole
        // test. Done HERE, before `results[]`, the report row and the
        // `step:pass` event are built from it, so all three read the same
        // sentence. The unconditional branch already wrote its own
        // (stories/step-flow-control.md).
        if (stepResult.flowControl && !unconditionalFlowControl) {
          stepResult.aiExplanation = flowControlExplanation(
            frameLabel(expansionOrigins ?? undefined, expandedFrames, i),
            stepResult.aiExplanation,
          );
        }

        // Collect per-step output captures from resolvedParameters. Union
        // explicit `[output: X]` declarations with every `as` name this step's
        // own successful read/count actions used (see `autoCapturedNames` for
        // why that set is filtered the way it is — issue 042).
        const captureVars = new Set([...outputVars, ...autoCapturedNames(stepResult)]);

        const stepOutputs: Record<string, string> = {};
        for (const varName of captureVars) {
          // `hasOwn`, not `in`: `in` walks the prototype chain, so an
          // `[output: constructor]` — or an `as` name the model chose — was
          // "captured" off `Object.prototype` and the `Object` FUNCTION
          // travelled into `session.outputs`, the `capture` wire event and
          // the step's outputs, all three typed `string`.
          if (Object.hasOwn(resolvedParameters, varName)) {
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

        // Map internal StepResult to API response format. `'skipped'` travels
        // as itself — see the branched path above for why the old narrowing to
        // `'passed'` was a false green rather than a compatibility shim.
        const resultStatus: StepResultResponse['status'] = stepResult.status;

        results.push({
          step: originalStep,
          status: resultStatus,
          actions: stepResult.turns.flatMap((t) => t.subActions).map((sa) => sa.action),
          screenshot: screenshotValue,
          reasoning: stepResult.aiExplanation ?? '',
          outputs: stepOutputs,
          // `status` stays `'failed'` — the step did not do what it said — so this
          // is how an API reader tells a failure the author chose not to stop on
          // from one that ended the run (stories/step-failure-outcomes.md,
          // decision 9). Omitted on every other row.
          ...(stepResult.tolerated && { tolerated: true }),
          // The author's own words beside the framework's, on the same terms.
          ...(stepResult.warning !== undefined && { warning: stepResult.warning }),
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
        //
        //   sourceSection — name of the outermost inline section this step
        //                  came from, skipping any that a skill declared
        //                  privately. Independent of sourceSkill: a step
        //                  inside `section A → skill S` carries both.
        const sourceSkill = outermostSkillName(
          expansionOrigins?.[i]?.frameId,
          expansionFrames,
        );
        const sourceSection = outermostSectionName(
          expansionOrigins?.[i]?.frameId,
          expansionFrames,
        );
        // Resolved once, here, and used for BOTH the report row and the
        // pass/fail event below — so the tab the report shows and the tab the
        // client was told are the same tab by construction rather than by two
        // reads that happen to agree. After the step, deliberately: a step
        // that switched tabs must report the one it ended in.
        const tabAfterStep = await tabSpread();

        // Which iteration of a looped section this step belongs to, derived
        // from its frame rather than tracked alongside it — the frame is the
        // iteration's identity, and a parallel array would be one more thing
        // to keep aligned through expansion.
        // A runtime loop's own tracker answers first: a control line's tail may
        // be a plain instruction, which produces no frame at all, so there
        // would be nothing for the frame walk below to derive a marker from
        // (stories/control-flow.md). A section tail has both answers and they
        // agree; a table-driven section loop has only the frame's.
        const loop =
          loops.markerFor(i) ??
          loopMarkerFor(emittedFrameId(i), expansionFrames, frameInputs, resolvedParameters);

        const fullResult: StepResult = {
          ...stepResult,
          index: i + 1,
          // The SUBSTITUTED, masked text — what the CLI has always stamped, and
          // what the report's step line should read. The server stamped the
          // authored `originalStep` here, so a data-driven row's report said
          // `Enter the email {{email}}` five times over and never which email
          // (stories/placeholder-preserving-actions.md, decision 9).
          instruction: redact(stepInstruction, secretsNow()),
          ...(Object.keys(stepOutputs).length > 0 && { outputs: stepOutputs }),
          ...(sourceSkill && { sourceSkill }),
          ...(sourceSection && { sourceSection }),
          ...(loop && { loop }),
          ...tabAfterStep,
        };
        fullStepResults.push(fullResult);
        // The AI turn this step needed only because its entry threw. Counted
        // only when the step then passed: "healed" means the AI covered for
        // the broken entry, and a step that failed anyway wasn't covered —
        // it reports through the step:fail path, not the healed summary.
        if (isHealedStep(fullResult)) {
          healedTokens += Math.max(0, session.tokenTracker.runTotal - tokensAtStepStart);
        }

        // Queue this step's code-behind entry and move on
        // (stories/compile-as-you-go.md): the browser does not wait, and a
        // step that ran as code, failed, or is already `ai: true` is dropped
        // inside `offer`. The parameter map is snapshotted because the run
        // keeps writing to its own.
        if (liveCompile) {
          const binding = generationBindings.bindingFor(i);
          liveCompile.offer({
            index: i,
            ...(binding && { binding }),
            result: fullResult,
            resolvedParameters: liveCompileSnapshot(resolvedParameters),
          });
        }

        // Update conversation history
        let currentUrl = '';
        try {
          currentUrl = session.browserSession!.pageTracker.getActive().url();
        } catch {
          // ignore
        }

        session.conversationHistory.push(
          formatStepHistoryEntry(
            session.totalStepsExecuted + 1,
            // Masked. `## Prior Steps` is built from these lines and goes to
            // the model on every later step, so an unmasked one put the
            // password in front of the model for the rest of the run
            // (stories/placeholder-preserving-actions.md §Where a secret still
            // goes).
            redact(interpolated, secretsNow()),
            stepResult.status === 'passed',
            currentUrl,
          ),
        );
        // The steps a return skips are NOT added to the history (decision 4),
        // and `formatStepHistoryEntry` carries no explanation — so without this
        // line the model's `## Prior Steps` would show a section that started
        // and then simply stopped, with nothing saying it ended on purpose.
        //
        // Numbered off `totalStepsExecuted`, like the line above it and unlike
        // the reason strings: this history is the model's, it counts executed
        // steps and spans batches, and a 1-based EXPANSION index dropped into
        // it would name a different step than the one the model just read
        // about.
        if (stepResult.flowControl) {
          session.conversationHistory.push(
            `[flow] step ${session.totalStepsExecuted + 1} ` +
              `${stepResult.aiExplanation ?? 'returned'} — ` +
              'the rest of that flow was skipped',
          );
        }
        // The same problem one step on: the entry above says this step failed and
        // the next says the run carried on regardless, so without this line the
        // model reads a framework that ignored a failure (decision 6). Numbered
        // off `totalStepsExecuted` like the entry it explains.
        if (stepResult.tolerated) {
          session.conversationHistory.push(
            toleratedHistoryLine(session.totalStepsExecuted + 1),
          );
        }

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
            // How the step passed, for the gutter: as code (the code mark), or under AI
            // after its entry threw (⚠). Both ride the pass event because a
            // stale step DID pass — the entry is what failed.
            ...(stepResult.fromCodeBehind && { fromCodeBehind: true }),
            ...(stepResult.codeBehindStale && {
              codeBehindStale: {
                file: stepResult.codeBehindStale.file,
                error: stepResult.codeBehindStale.error,
              },
            }),
            // Which surface answered it (SPEC-use-computer.md §4.5, §10.3).
            // Sent only when it was the computer, so a browser-only run's
            // event stream is byte-identical to the one this server sent
            // before computer mode existed.
            ...(stepResult.surface === 'computer' && { surface: 'computer' as const }),
            ...tabAfterStep,
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
            ...scopeMasking(),
          });

          // Persist every resolvedParameters entry to session scope — a
          // backstop for cross-batch continuity. The capture loop above now
          // covers both `[output: X]` steps and any `as`-tagged read/count
          // capture (issue 042), but it only reaches values written through
          // that one path; this sweep is unconditional (e.g. it also carries
          // forward `[tool: ... out.foo="bar"]` bindings, a separate write
          // path). Without it, values would be lost when a breakpoint splits
          // the run into separate batch requests (the next batch seeds
          // resolvedParameters from session.outputs, which never got the
          // value otherwise).
          for (const [key, value] of Object.entries(resolvedParameters)) {
            if (!key.startsWith('__skill')) {
              session.outputs[key] = value;
              // Anything that reaches the sweep unlabelled was set by a
              // `[store as:]` modifier (the other write sites label inline).
              // Default to 'capture'; never overwrite an existing label.
              if (!(key in session.outputSources)) session.outputSources[key] = 'capture';
            }
          }

          // ── The step ended the flow it was in ───────────────────────
          //
          // Everything from here to the end of the returning step's frame is
          // skipped: no hooks, no tokens, no screenshot, no conversation
          // history — and, crucially, no `transitionToFrame`. A nested call
          // inside the returned body must not push and pop clean, or its call
          // line would paint ✓ for work that never ran
          // (stories/step-flow-control.md, decision 9).
          if (stepResult.flowControl) {
            const label = frameLabel(expansionOrigins ?? undefined, expandedFrames, i);
            // The reason carries the returning step's line so it is findable
            // from the editor — which numbers by source line, not by the
            // expanded index the reason's `step N` uses.
            //
            // `expansionRawSteps`, not `originalStep`: the latter is
            // `effectiveSteps[i]`, which the expander has already put skill
            // arguments and row values through, so a body step reading `If
            // {{password}} is remembered then return` would put the literal
            // password on the wire, in the run log, in the report and on a
            // TestBench hover. `rawSteps` is the match side — deliberately
            // never interpolated (expander.ts, `applySkillScope`) — so it is
            // the line as authored, on every shape the wire can describe. A
            // LOOPED SECTION body used to be the exception: the wire shape
            // carries no `rawSteps` (contract §3.2), so `matchInput` fell back
            // to `steps[i]`, which for a looped body is the row-interpolated
            // text. It no longer does — the expander pins that body's match
            // side to the section's own authored lines (`section.rawSteps ??
            // section.steps`, stories/data-driven-rows.md), because a divergent
            // match side was binding one code-behind entry per row. So the
            // `?? originalStep` is only the shape backstop it reads as:
            // `expansionRawSteps` starts as `request.steps` and is index-parallel
            // to `effectiveSteps` on every path.
            const returningText = expansionRawSteps[i] ?? originalStep;
            const reason = skippedByReturnReason(i, label, returningText);
            // `endIndex` still bounds the run. A bounded re-run must not report
            // steps it was never going to reach in this batch as skipped.
            //
            // `returnExit` then clamps the frame's answer to the innermost
            // control body containing the returning step, because an iteration
            // is a flow too — see its doc comment. It also says whether the
            // planner may have a say at the loop tail below.
            const frameExit = Math.min(
              frameExitIndex(
                expansionOrigins ?? undefined,
                expandedFrames,
                i,
                effectiveSteps.length,
              ),
              endIndex,
            );
            const bounded = returnExit(controls, i, frameExit);
            const exit = bounded.exit;
            flowControlEnclosed = bounded.enclosed;
            // Call lines already reported, keyed by the DOCUMENT ADDRESS the
            // client acts on — the parent frame's file and the line in it —
            // rather than by frame id or by parent frame id.
            //
            // A looped section is one frame per iteration, and every iteration
            // shares the one call line. Keyed by the frame's own id, that line
            // would be announced skipped three times over for a three-row
            // table. Keyed by the PARENT's id it is still announced once per
            // iteration whenever the call sits INSIDE the loop body: the
            // parents are the iteration frames, which are distinct, while the
            // `[skill: …]` line they all point at is one line in one file.
            // Only the address the client paints is the same in both cases.
            const callLinesEmitted = new Set<string>();
            /**
             * The returning step's frame in the ORIGINAL id space — not
             * `stepFrameId`, which is `emittedFrameId(i)` and is a per-pass
             * CLONE inside a loop body.
             *
             * Both this comparison and the walk below run over `origins` and
             * `expandedFrames`, and neither of those ever holds a clone: the
             * origins are static, and the clones live only in the wire
             * `FrameInfo` table (`cloneFramesForPass`). Comparing a clone id
             * against an original never matched, so every step of a returning
             * loop pass looked like it belonged to a DIFFERENT frame and the
             * loop's own guard line was announced skipped — while the loop was
             * still running (stories/control-flow.md §"Composition with
             * `If … then return`").
             */
            const returningFrameId = expansionOrigins?.[i]?.frameId ?? '';
            /** The address a client paints: the file a line lives in, and the
             *  line. One key space for call lines and step lines alike. */
            const addressOf = (uri: string | undefined, line: number): string =>
              `${uri ?? request.testFilePath ?? ''}#${line}`;
            const emitCallLineFor = (frameId: string): void => {
              // Walk out to the returning step's own frame, then report inwards,
              // so a section called from a section names the outer call first
              // and the stream reads in document order: call, then body.
              const chain: string[] = [];
              let cur: string | null = frameId;
              const seen = new Set<string>();
              while (cur && cur !== '' && cur !== returningFrameId && !seen.has(cur)) {
                seen.add(cur);
                chain.unshift(cur);
                cur = expandedFrames[cur]?.parentId ?? null;
              }
              for (const id of chain) {
                const f = expandedFrames[id];
                // The call line lives in the PARENT's file, not this frame's:
                // a skill frame's own `uri` is the skill file, while the
                // `[skill: ...]` line the author sees is in whatever called it.
                if (!f || f.invocationLine === null) continue;
                const parentId = f.parentId ?? '';
                const parentFrame =
                  parentId === ''
                    ? request.testFilePath
                      ? ({
                          id: '',
                          parentId: null,
                          kind: 'test',
                          uri: request.testFilePath,
                          line: 0,
                        } as FrameInfo)
                      : undefined
                    : expansionFrames?.[parentId];
                // The parent frame's own file, which is where this call line
                // lives. Falls back to the parent's id only when no frame
                // answers for it, which leaves the key no worse than it was.
                const address = addressOf(parentFrame?.uri ?? parentId, f.invocationLine);
                if (callLinesEmitted.has(address)) continue;
                callLinesEmitted.add(address);
                emit({
                  type: 'step:skip',
                  line: f.invocationLine,
                  ...(parentFrame && { frame: parentFrame }),
                  reason,
                });
              }
            };
            for (let j = i + 1; j <= exit; j++) {
              const skippedFrameId = expansionOrigins?.[j]?.frameId ?? '';
              if (skippedFrameId !== returningFrameId) emitCallLineFor(skippedFrameId);
              const skippedFrame = frameInfoFor(j);
              // A step line and a call line can be the SAME line, and with
              // control flow they routinely are: a section used as a control
              // line's tail is invoked from the guard's own line, so the
              // guard's `invocationLine` is a numbered step in the expanded
              // list. Recording the step's address in the same set the call
              // lines use is what stops one line being announced skipped
              // twice — once as itself and once as the call it also is.
              callLinesEmitted.add(addressOf(skippedFrame?.uri, sourceLineFor(j)));
              emit({
                type: 'step:skip',
                line: sourceLineFor(j),
                ...(skippedFrame && { frame: skippedFrame }),
                reason,
              });
              const skippedInstruction = effectiveSteps[j] ?? '';
              results.push({
                step: skippedInstruction,
                status: 'skipped',
                actions: [],
                screenshot: '',
                reasoning: reason,
                outputs: {},
              });
              // The report's row, so the HTML says "N passed, M skipped" with
              // the reason on each skipped row rather than losing them
              // (decision 15).
              const skippedResult = skippedByReturn(j, skippedInstruction, i, label, returningText);
              const skippedSkill = outermostSkillName(skippedFrameId, expansionFrames);
              const skippedSection = outermostSectionName(skippedFrameId, expansionFrames);
              // The same two-answer expression an executed step's marker uses,
              // and for the same two reasons. `loops.markerFor` answers first
              // because a control line's tail may be a plain instruction,
              // which produces no frame at all; the frame walk needs the
              // CLONE id, because `iteration` lives only on the per-pass clone
              // `cloneFramesForPass` writes — `skippedFrameId` is the ORIGINAL
              // (the id space the call-line walk above deliberately runs in)
              // and answered `undefined` for every row, breaking the report's
              // iteration band at exactly the rows a return produced.
              const skippedLoop =
                loops.markerFor(j) ??
                loopMarkerFor(emittedFrameId(j), expansionFrames, frameInputs, resolvedParameters);
              const fullSkipped: StepResult = {
                ...skippedResult,
                ...(skippedSkill && { sourceSkill: skippedSkill }),
                ...(skippedSection && { sourceSection: skippedSection }),
                ...(skippedLoop && { loop: skippedLoop }),
              };
              fullStepResults.push(fullSkipped);
              // Offered to the compile too, and for the opposite reason to the
              // one that might suggest withholding it: a step that never ran is
              // no evidence, so it must be NAMED as not attempted rather than
              // quietly left without an entry (decision 12, and the same
              // bookkeeping a client stop gets). `generationRefusal` is the one
              // place that decides that; it already has the `skipped` branch,
              // and this is what reaches it. Without the offer, a Run & Compile
              // of a test that returns wrote entries for what ran and said
              // nothing at all about the rest.
              if (liveCompile) {
                const skippedBinding = generationBindings.bindingFor(j);
                liveCompile.offer({
                  index: j,
                  ...(skippedBinding && { binding: skippedBinding }),
                  result: fullSkipped,
                  resolvedParameters: liveCompileSnapshot(resolvedParameters),
                });
              }
              logger.info(`Session "${sessionId}" step ${j + 1} skipped — ${reason}`);
            }
            // Consumed by the loop tail. `stepsCompleted` is untouched on
            // purpose: it counts steps that EXECUTED (decision 9).
            flowControlJumpTo = exit;
          }
        } else if (stepResult.tolerated) {
          // `otherwise continue` (stories/step-failure-outcomes.md, decision 6).
          // Everything the failed branch below does must NOT happen here: no
          // `overallStatus`, no `errorInfo`, and above all no `break` — the next
          // step runs in the same frame, with the frame still open and
          // `loops.abandon` uncalled, so a loop body keeps looping.
          //
          // It is still a `step:fail`, with the flag beside it: the step did
          // not do what it said, and a client that does not know the flag
          // paints ✗ as it always did, which is the safe direction (decision 9).
          logger.warn(toleratedLogLine(i + 1, stepResult.error));
          emit({
            type: 'step:fail',
            line: sourceLineFor(i),
            error: stepResult.error ?? 'Step failed',
            tolerated: true,
            // The two flags compose, and the runtime already produces the
            // combination: a hand-written `step.fail()` inside the entry of a step
            // carrying `otherwise continue` is deliberate AND tolerated. Dropped
            // here, the amber hover opened "Its code-behind failed:" over the
            // author's own sentence (decisions 2 and 6).
            ...(stepResult.deliberate && { deliberate: true }),
            // The author's sentence: the explanation does not travel on this
            // event, so without this field the warning reaches no client at all.
            ...(stepResult.warning !== undefined && { warning: stepResult.warning }),
            ...(screenshotValue && { screenshot: screenshotValue }),
            ...frameSpread,
            ...(stepResult.fromCodeBehind && { fromCodeBehind: true }),
            ...(stepResult.codeBehindStale && {
              codeBehindStale: {
                file: stepResult.codeBehindStale.file,
                error: stepResult.codeBehindStale.error,
              },
            }),
            ...(stepResult.surface === 'computer' && { surface: 'computer' as const }),
            ...tabAfterStep,
          });
          // The same scope snapshot the two other outcomes emit: a step that
          // failed and was carried past is when the Variables panel matters most.
          emit({
            type: 'frame:scope',
            frameId: stepFrameId,
            scope: { ...resolvedParameters, ...(frameInputs[stepFrameId] ?? {}) },
            ...scopeMasking(),
          });
          // It EXECUTED (decision 6). `session.totalStepsExecuted` already counted
          // it above, before the pass/fail split; this is the other half of the
          // pair, and a progress bar that stalled here would not be counting
          // progress.
          stepsCompleted++;
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
            // The author wrote this failure and its message
            // (stories/step-failure-outcomes.md, decision 2). The client words
            // it as "failed as written" rather than as a malfunction.
            ...(stepResult.deliberate && { deliberate: true }),
            ...(screenshotValue && { screenshot: screenshotValue }),
            ...frameSpread,
            // Where the failure came from, so the client can say "the
            // code-behind failed" instead of a bare error: the entry itself
            // (strict replay / step.expect), or — codeBehindStale — the entry
            // threw, the step fell through to AI, and the AI failed too. The
            // stale error rides along because `error` above only carries the
            // second failure of that pair.
            ...(stepResult.fromCodeBehind && { fromCodeBehind: true }),
            ...(stepResult.codeBehindStale && {
              codeBehindStale: {
                file: stepResult.codeBehindStale.file,
                error: stepResult.codeBehindStale.error,
              },
            }),
            ...(stepResult.surface === 'computer' && { surface: 'computer' as const }),
            ...tabAfterStep,
          });
          // Phase 4 — surface the scope at failure time too. The user
          // wants to see "what were the variables when this step blew
          // up." Same flat shape as the pass-path emission above.
          // Same frameInputs overlay rationale (see above).
          emit({
            type: 'frame:scope',
            frameId: stepFrameId,
            scope: { ...resolvedParameters, ...(frameInputs[stepFrameId] ?? {}) },
            ...scopeMasking(),
          });
          break;
        }

        // ── Step-mode pause decision ──────────────────────────────────
        //
        // AFTER the outcome chain rather than inside its `passed` branch,
        // because it must apply to every outcome the run CONTINUES past — a pass
        // and a tolerated failure alike (stories/step-failure-outcomes.md,
        // decision 6). Inside the `passed` branch it silently did not, so F10
        // onto `Dismiss the banner otherwise continue` ran two steps for one
        // keypress. The plain-failure branch above `break`s.
        //
        // When the client started this batch with `stepMode !== 'continue'`,
        // we pause after each step depending on the depth relationship
        // between the just-executed step and the next one. The yellow ▶
        // moves to the next step's frame/line on the client; the loop
        // blocks on `pendingRunControl` until the client sends a new
        // mode via the `run-control` endpoint.
        //
        // `nextI` is the POST-JUMP index (decision 10). After a return the
        // step that will actually run next is the one after the flow that
        // ended, and pausing on `i + 1` would park the yellow ▶ on a line
        // this run has already declared skipped.
        //
        // The three ways the run leaves step `i`, and the three answers,
        // which must be the SAME expression the loop tail below resumes on
        // or the ▶ lands where the run is not going:
        //
        //  - a return inside a control body → `advanceAfter(exit)`, which is
        //    the loop's guard (backwards!) or the line past the chain. `exit
        //    + 1` said "the line after the body", which for a chain member
        //    is the next member's tail — a line the decision has already
        //    declared skipped, which is the exact failure this comment says
        //    it is avoiding;
        //  - a return in the main flow → `exit + 1`, the run ending;
        //  - no return at all → `advanceAfter(i)`, because an ordinary step
        //    that closes a loop body sends the run back to the guard too.
        //
        // `advanceAfter` is pure (`planAfterStep` takes its state read-only),
        // so asking it here and again at the tail cannot double-count a pass.
        // `flowControlJumpTo` is only set on the passed path, so a tolerated step
        // always takes the third answer.
        const nextI =
          flowControlJumpTo !== null
            ? flowControlEnclosed
              ? advanceAfter(flowControlJumpTo)
              : flowControlJumpTo + 1
            : advanceAfter(i);
        if (currentMode !== 'continue' && nextI <= endIndex) {
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

        // Refresh active browser from the tracker — openBrowser /
        // switchBrowser / closeBrowser may have shifted which browser is
        // active. If the tracker has no browsers left (closeBrowser closed
        // the only one) or the active one was disconnected by the step
        // (e.g. "Close the browser"), tear down the session.
        //
        // Skipped entirely when the session has never had a browser (§4.6) —
        // a computer-surface run that launched none. `getActive()` throws
        // there too, but "no browser was ever opened" is not "the step closed
        // the browser", and tearing the session down for it would end a
        // desktop-only run at its first step.
        if (session.browserTracker.hasActive() || session.browserSession) {
          let trackerEmpty = false;
          try {
            session.browserSession = session.browserTracker.getActive();
          } catch {
            trackerEmpty = true;
          }
          if (trackerEmpty || !session.browserSession || isBrowserClosed(session.browserSession)) {
            logger.info(`Session "${sessionId}": browser closed by step, removing session`);
            session.status = 'closed';
            this.sessions.delete(this.sessionKey(sessionId));
            break;
          }
        }

        // Where the run goes next, with both features' rules applied in the
        // one place they meet.
        //
        // Ordinarily: a step that closes a loop body sends the run back to its
        // guard rather than to the next line — the jump-back the flat step
        // list never grows to accommodate. `i++` follows, so aim one short; a
        // no-op for every step that closes nothing.
        //
        // After a `return`: resume after the flow that ended. Last thing in
        // the body so every per-step tail above (the browser refresh included)
        // still ran for the returning step, which is an ordinary passed step
        // (stories/step-flow-control.md, decision 4). `flowControlEnclosed`
        // is what decides whether the planner gets a say: a return that ended
        // an ITERATION must let the loop re-evaluate, while one that ended the
        // MAIN FLOW must not be walked anywhere — see `returnExit`.
        if (flowControlJumpTo !== null) {
          i = flowControlEnclosed ? advanceAfter(flowControlJumpTo) - 1 : flowControlJumpTo;
        } else {
          i = advanceAfter(i) - 1;
        }
      }
      // Whatever the last decision skipped and nothing moved past — an
      // `Otherwise` whose body was the end of the batch, most often. Not on an
      // abort: the run stopped before it got there, and reporting those lines
      // as decided-against would put words in the decision's mouth.
      if (hasControls && overallStatus !== 'aborted') flushSkips('all');
    } finally {
      // The run's steps are done; everything from here is tail
      // (stories/compile-tail-progress.md). Said HERE — the first statement
      // after the step loop, ahead of the report, the recording write and the
      // drain — because every one of those awaits is time the queue keeps
      // spending, and a forecast issued after them is a report.
      liveCompile?.runStepsEnded();
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
        // `?.` — a run that never launched a browser (§4.6) has no title, and
        // that is a report with a blank title, not a failure.
        pageTitle = (await session.browserSession?.pageTracker.getActive().title()) ?? '';
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
    // Freeze the run token totals now (issue 021). The `run*` getters are
    // relative to this batch's `markRunStart` baseline, so reading them here
    // captures exactly this run's usage — including all AI calls that completed
    // before a stop. A reused session's next run rebaselines, so we must
    // snapshot rather than recompute when delivering to a stopped client later.
    const runTokens: RunTokens = {
      total: session.tokenTracker.runTotal,
      input: session.tokenTracker.runInputTotal,
      output: session.tokenTracker.runOutputTotal,
    };

    let reportPath: string | undefined;
    if (fullStepResults.length > 0) {
      try {
        const reportStatus: 'passed' | 'failed' =
          overallStatus === 'passed' ? 'passed' : 'failed';
        const passedSteps = fullStepResults.filter((s) => s.status === 'passed').length;
        // Exclude the interrupted (stopped) step from the failed count — it's
        // rendered as its own "aborted" state, not a failure (issue 021).
        // `&& !s.tolerated` widens that same filter a second time and for the same
        // reason: a step the author said to carry past is a failure nobody stopped
        // on, so it is not what makes a run red (decision 6). Counted separately
        // below rather than dropped — the row still says `failed`.
        const failedSteps = fullStepResults.filter(
          (s) => s.status === 'failed' && !s.interrupted && !s.tolerated,
        ).length;
        const toleratedSteps = fullStepResults.filter(
          (s) => s.status === 'failed' && s.tolerated,
        ).length;
        // The steps a return left behind (stories/step-flow-control.md,
        // decision 15). The CLI and the Electron runner have always set this;
        // the server did not, so a TestBench run — the way most people run a
        // test — produced a report whose header said "4 passed" of 5 steps and
        // never said where the fifth went. `generateReport` reads
        // `skippedSteps ?? 0` and the template hides the tile at 0, so the
        // count was silently dropped rather than rendered wrong.
        const skippedSteps = fullStepResults.filter((s) => s.status === 'skipped').length;
        const totalSubActions = fullStepResults.reduce(
          (sum, s) => sum + s.turns.reduce((tSum, t) => tSum + t.subActions.length, 0),
          0,
        );
        // Name the report after the TEST FILE, not the session id: a batch run
        // uses a unique `<path>::run-N` session id (so two runs of the same file
        // are two sessions) which must NOT leak into the report name/file. Falls
        // back to sessionId for clients that don't send testFilePath.
        const fileForName = request.testFilePath ?? sessionId;
        const testName = basename(fileForName, '.md').replace(/^.*[\\/]/, '') || sessionId;
        // The masked copy is the one that renders — now, and again when the
        // session closes and the video link is added (`pendingVideo`).
        const report: TestReport = redactReport({
          testName,
          filePath: fileForName,
          tags: [],
          status: reportStatus,
          steps: fullStepResults,
          totalSteps: stepsTotal,
          passedSteps,
          failedSteps,
          // Omitted (not 0) on a run that skipped nothing, so a run that never
          // returns writes the report it always did — the CLI's rule.
          ...(skippedSteps > 0 && { skippedSteps }),
          // The header reads "7 passed, 1 tolerated" only when there is something
          // to say (decision 6).
          ...(toleratedSteps > 0 && { toleratedSteps }),
          totalSubActions,
          durationMs: Date.now() - runStartTime,
          tokensUsed: runTokens.total,
          inputTokens: runTokens.input,
          outputTokens: runTokens.output,
          date: new Date().toISOString(),
          // Distinguish a user stop from a real failure (issue 021). `status`
          // stays a valid StepStatus ('failed'); `aborted` is the overriding
          // display state the report generator renders as "ABORTED".
          ...(overallStatus === 'aborted' && { aborted: true }),
          ...(session.sessionConfig.baseUrl !== undefined && { baseUrl: session.sessionConfig.baseUrl }),
          ...(Object.keys(resolvedParameters).length > 0 && { parameters: resolvedParameters }),
        }, secretsNow());

        // A row of a data-driven run writes no report of its own: it joins the
        // accumulator, and the whole run gets one report when the client posts
        // the finalise (stories/data-driven-rows.md, decision 12). `done`
        // therefore carries no `reportPath` for these batches.
        if (request.dataRow !== undefined) {
          this.accumulateRow(
            sessionId,
            {
              report,
              dataRowIndex: request.dataRow - 1,
              dataRowCount: request.dataRowCount ?? request.dataRow,
              dataRowValues: request.dataRowValues ?? {},
              secrets: secretsNow(),
            },
            session.reportOutputDir,
          );
          // The row's own `.webm` still finalises at the close between rows.
          // There is no per-row report to re-render, so the saved path is
          // written onto this same `report` object — the accumulator holds the
          // reference — and lands when the merge renders.
          if (session.videoMode !== 'off') {
            session.pendingVideo = {
              report,
              reportPath: '',
              passed: overallStatus === 'passed',
              dataRowIndex: request.dataRow - 1,
            };
          }
        } else {
          reportPath = await generateReport(report, session.reportOutputDir);
          logger.info(`Report saved: ${reportPath}`);

        // Video (Tier 1 server limitation): a reusable session keeps its
        // browser context open between runs, so the .webm can't be finalised
        // now (saveAs would hang awaiting page close). Retain the report +
        // path; finalizeMainPageVideo runs at closeSession, then re-renders
        // this report with `videoRelPath` set. Net effect: the video link
        // materialises only when the session is CLOSED — an explicit session
        // DELETE or server shutdown, NOT at the end of each run and NOT on a
        // plain re-run (which reuses the open context and overwrites this
        // pendingVideo; the single context-spanning recording follows the
        // last run — see caveat #8 in stories/video-recording.md).
          if (session.videoMode !== 'off') {
            session.pendingVideo = {
              report,
              reportPath,
              passed: overallStatus === 'passed',
            };
          }
        }
      } catch (err) {
        logger.warn(`Failed to generate HTML report for session "${sessionId}": ${String(err)}`);
      }
    }

    // The code-behind last-run sidecar (stories/codebehind-compile.md §The
    // runtime stops generating). The CLI runner writes its own; without this
    // one a TestBench run — the way most people run a test — leaves the
    // sidecar's two readers nothing: `collectStaleKeys`
    // (src/codebehind/compile.ts), the selection behind `--only-stale`, and
    // `LiveCompiler.priorFailure`, which is what routes a Compile This Step
    // through the repair prompt instead of generating from scratch. NOT the ⚠
    // gutter — nothing in testbench-native reads this file; the mark and its
    // hover come off the live step event's `codeBehindStale`.
    //
    // Only for a run that describes the whole test as it stands: a subset batch
    // (breakpoint continuation, `[input:]` split, partial re-run) knows about
    // some of the steps, and a sidecar covering some of the steps reads as one
    // covering all of them. A compile's own runs are excluded for the reason
    // the CLI excludes them — a Record (code-behind off) or a Replay
    // (candidate, not the real file) would stamp its own shape over the
    // findings the compile is acting on.
    if (
      request.testFilePath &&
      !isSubsetBatch &&
      request.startAt === undefined &&
      !codeBehindOff &&
      !cb?.candidateFiles
    ) {
      const lastRunSteps: LastRunStep[] = [];
      for (const result of fullStepResults) {
        if (result.hookScope || result.interactiveAdHoc || result.interactiveChild) continue;
        // A step a return left unrun is deliberately absent, exactly as the
        // CLI writer leaves it absent (test-runner.ts): the sidecar answers
        // "which entries does the next compile need to regenerate", and a step
        // that never ran is no evidence either way
        // (stories/step-flow-control.md, decision 12). Written, its row would
        // claim `fromCodeBehind: false, stale: false` — "ran under AI and was
        // fine" — about a step nothing executed, and `--only-stale` would then
        // skip a broken entry on the strength of it.
        if (result.status === 'skipped') continue;
        const i = result.index - 1;
        const binding = codeBehind.bindingFor(i);
        const stale = result.codeBehindStale;
        // Same as the CLI writer (test-runner.ts): a keyless run's broken
        // entry never healed, so it carries no `codeBehindStale` and no heal
        // counter moves — but the sidecar is what `--only-stale` and Compile
        // This Step read to find the step that needs repairing, so the row is
        // stale (stories/keyless-replay-and-gateway-env.md §Part B). Both
        // writers or neither: a fix in one of them only works for whoever ran
        // the test the other way.
        const healSkipped = stale ? undefined : result.codeBehindHealSkipped;
        const failure = stale ?? healSkipped;
        lastRunSteps.push({
          index: result.index,
          source: binding?.source ?? expansionRawSteps[i] ?? effectiveSteps[i] ?? '',
          ...(binding?.section !== undefined && { section: binding.section }),
          // The entry's target file, so a repair looking this row up cannot
          // conflate a skill-body step with an identically-worded test step.
          ...(binding?.file !== undefined && { file: binding.file }),
          // Which of the identically-worded steps of this frame instance it
          // is. Without it a repair has to find its row by counting, and a
          // looped body's rows are iteration-major — see `LastRunStep`.
          ...(binding?.occurrence !== undefined && { occurrence: binding.occurrence }),
          status: result.status,
          fromCodeBehind: result.fromCodeBehind === true,
          stale: failure !== undefined,
          ...(failure && { error: failure.error }),
          ...(healSkipped && { healSkipped: true }),
        });
      }
      if (lastRunSteps.length > 0) await writeLastRun(request.testFilePath, lastRunSteps);
    }

    // Hand the whole run to an in-process caller (the compiler). After the
    // sidecar, so a compile that reuses this run sees the same disk state a
    // fresh one would.
    // The recording, beside the test, when this run was asked to capture —
    // a compile's Record (stories/codebehind-recording-on-disk.md). Gated on
    // the capture flag alone: a Record with code-behind off is excluded from
    // the sidecar above and must still be recorded. Nothing of it is kept on
    // the session afterwards.
    // A compile-mode run accumulates its steps on the session and writes the
    // recording from ALL of them, so block 2 cannot wipe block 1's. Renumbered
    // into the run's own index space, because each request numbers its steps
    // from 1.
    const openCompile = liveCompile ? session.liveCompile : undefined;
    if (openCompile && liveCompile) {
      const offset = liveCompile.blockOffset;
      for (const result of fullStepResults) {
        if (result.hookScope || result.interactiveAdHoc || result.interactiveChild) continue;
        const at = offset + result.index;
        openCompile.steps.push({ ...result, index: at });
        const binding = generationBindings.bindingFor(result.index - 1);
        if (binding) {
          openCompile.identities[at] = {
            source: binding.source,
            ...(binding.section !== undefined && { section: binding.section }),
            occurrence: binding.occurrence,
            file: binding.file,
          };
        }
      }
      if (overallStatus !== 'passed') openCompile.anyFailed = true;
    }

    if (request.testFilePath && captureStepContext) {
      // Authored text + section scope + occurrence per step, so a later
      // single-step splice can find its slot by identity rather than by
      // position (stories/compile-as-you-go.md §The recording). All three
      // parts, because the first two do not separate a body that says the
      // same thing twice.
      const identities: Record<
        number,
        {
          source: string;
          section?: string | undefined;
          occurrence?: number | undefined;
          file?: string | undefined;
        }
      > = {};
      for (const result of fullStepResults) {
        const binding = generationBindings.bindingFor(result.index - 1);
        if (!binding) continue;
        identities[result.index] = {
          source: binding.source,
          ...(binding.section !== undefined && { section: binding.section }),
          occurrence: binding.occurrence,
          // The binding's target `.steps.ts` — the discriminator that keeps a
          // skill-body step from claiming (or clobbering) the recording slot
          // of a test-frame step with identical authored text.
          file: binding.file,
        };
      }
      // A compile-mode run writes from the accumulation, so a split run's
      // second block does not replace the first block's recording with a
      // recording of two steps.
      const recordedSteps = openCompile ? openCompile.steps : fullStepResults;
      const recordedIdentities = openCompile ? openCompile.identities : identities;
      const recording: RecordingInput = {
        steps: recordedSteps,
        status:
          (openCompile ? !openCompile.anyFailed : overallStatus === 'passed') ? 'passed' : 'failed',
        startedAt: openCompile ? openCompile.startedAt : new Date(runStartTime).toISOString(),
        parameters: resolvedParameters,
        ...(envDataCtx && { secrets: envDataSecretValues(envDataCtx) }),
        source: 'server',
        ...(Object.keys(recordedIdentities).length > 0 && { identities: recordedIdentities }),
      };
      // A Run & Compile is a full run and its recording supersedes the old one
      // entirely, as a Record's does. A Compile This Step knows only the steps
      // it was sent, so replacing wholesale would delete every sibling's
      // recording: it splices instead, and stamps the step it replaced with
      // its own `recordedAt`.
      if (request.compile === 'steps') await spliceRecording(request.testFilePath, recording);
      else await writeRecording(request.testFilePath, recording);
    }

    // The compile's own end (stories/compile-as-you-go.md): the trailing
    // generation queue drains, Review runs over each touched candidate file
    // on the Run & Compile path, and the proposal rides back on
    // `compile:result` — before `done`, so a client folding the stream has it
    // by the time the run is over. The server writes no `.steps.ts` here;
    // TestBench applies through its diff, as it does for a boxed compile.
    if (liveCompile) {
      // Numbers are the RUN's, not this block's: a client folding the summary
      // is looking at one test, however many requests it took to run it.
      const offset = liveCompile.blockOffset;
      const recorded = new Set(
        fullStepResults
          .filter((r) => !r.hookScope && !r.interactiveAdHoc && !r.interactiveChild)
          .map((r) => offset + r.index),
      );
      // Bounded to the slice: a request that ran `[startIndex, endIndex]`
      // never meant to attempt the steps outside it, and reporting them would
      // caption a clean single-step compile with "N step(s) not attempted".
      // Without a slice the bounds are the whole expansion, as before.
      const notAttempted: number[] = [];
      for (let n = offset + startIndex + 1; n <= offset + endIndex + 1; n++) {
        if (!recorded.has(n)) notAttempted.push(n);
      }
      // `&& !r.tolerated`: this is "where did the run stop", and a tolerated
      // failure stopped nothing (decision 6). Named as the stopping point it would
      // have captioned the whole compile `stopped at step N` for a run that went
      // on to finish.
      const firstFailed = fullStepResults.find(
        (r) => r.status === 'failed' && !r.interrupted && !r.tolerated,
      );
      // A DELIBERATE failure did not stop the run either — it ENDED it, where the
      // test says it ends (decisions 1–3), so there is nothing to fix. Told apart
      // HERE, once, because everything downstream words itself off which of the
      // two fields arrived: `stoppedAt` carrying this failure is how a Run &
      // Compile came to say "Step 9 failed under AI … Fix it, run, and compile
      // again" over a step that had done exactly what its line says. The boxed
      // pipeline (`compileTest`, src/codebehind/compile.ts) makes the same split
      // off the recording — one recording fact, two places it has to be true.
      const endedAsWritten = firstFailed?.deliberate === true ? firstFailed : undefined;
      const failed = endedAsWritten ? undefined : firstFailed;
      const outcome = await liveCompile.finish({
        // After the drain, so generation's own tokens are in the total —
        // `runTokens` above was frozen before the queue had finished.
        tokensUsed: session.tokenTracker.runTotal,
        notAttempted,
        ...(failed && {
          stoppedAt: { step: offset + failed.index, error: failed.error ?? 'the step failed' },
        }),
        ...(endedAsWritten && {
          endedAsWritten: {
            step: offset + endedAsWritten.index,
            error: endedAsWritten.error ?? 'the step failed as its text says',
          },
        }),
        ...(overallStatus === 'aborted' && { aborted: true }),
      });
      emit({
        type: 'compile:result',
        status: outcome.status,
        files: outcome.files,
        summary: outcome.summary,
      });
      // A `'steps'` compile is terminal by construction — it compiles the
      // steps it was sent and is never continued — so it must not stay on the
      // session. Left there, the next Continue of the test (which inherits
      // `'run'` and stamps `compileContinues`) matches it by file path and
      // appends its tail to a FINISHED `'steps'` compiler: no Review, step
      // numbers shifted by the old block's offset, and a wholesale recording
      // write built from the other compile's steps. A `'run'` compile is
      // retained on purpose: that is what carries a split run across blocks.
      if (request.compile === 'steps' && session.liveCompile?.compiler === liveCompile) {
        session.liveCompile = undefined;
      }
    }

    // Hand the whole run to an in-process caller (the compiler): it drove this
    // run and consumes the results now, in flight. They are not retained.
    internal?.onRunDetails?.({
      steps: fullStepResults,
      parameters: { ...resolvedParameters },
      tokens: runTokens.total,
    });

    // Record the finalized run so a client that STOPPED the run — and so closed
    // the SSE stream before the final `done` event — can recover the report path
    // and token totals via GET /sessions/:id/last-run (issue 021). `finalized`
    // is set unconditionally (even with no report) so the client's poll
    // terminates; `reportPath` is omitted when no report was written.
    this.recordLastRun(sessionId, {
      finalized: true,
      tokens: runTokens,
      ...(reportPath !== undefined && { reportPath }),
    });

    // Unwind any frames still on the stack — happens on early exit (fail,
    // error, abort) and on a clean finish where the last executed step was
    // inside a skill body. Clients need the matching pops to keep their
    // call-stack model consistent.
    transitionToFrame('');

    // Steps that healed a broken code-behind entry under AI, for the run's
    // closing summary line (stories/codebehind-selector-ambiguity.md §"A
    // healed run stops reporting as a clean pass").
    //
    // The same rows `countStepOrigins` (report/generator.ts) counts as stale,
    // filtered here rather than through it: a dozen api-server suites replace
    // that module wholesale with a three-export `vi.mock`, and importing a
    // fourth name would make every one of them throw on the `done` emit.
    // Hook and ad-hoc rows are excluded for the helper's reason — they are not
    // steps of the test.
    const healedSteps = fullStepResults.filter(
      // `isHealedStep`, not the bare flag: a failed step can carry it too (the
      // entry threw AND the AI attempt failed), and that one wasn't healed.
      (s) => !s.hookScope && !s.interactiveAdHoc && !s.interactiveChild && isHealedStep(s),
    ).length;

    emit({
      type: 'done',
      status: overallStatus,
      ...(reportPath && { reportPath }),
      ...(healedSteps > 0 && { healed: { steps: healedSteps, tokens: healedTokens } }),
      effectiveSettings: resolvedSettings.effective,
    });

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
