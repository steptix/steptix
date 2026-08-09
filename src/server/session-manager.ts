import { basename, dirname, join as pathJoin, relative as pathRelative, resolve as pathResolve, sep } from 'node:path';
import { stat } from 'node:fs/promises';
import { StepCache, frameScopedStepKey, cacheDirName, envCacheSegment } from '../cache/step-cache.js';
import { resolveProjectRoot } from './project-root.js';
import { arraysEqual, chooseCacheHashSource } from './cache-hash-source.js';
import { loadConfig } from '../config/loader.js';
import type { Config, EffectiveSettings, RunSettings } from '../config/types.js';
import { mergeRunSettings, resolveRunSettings } from '../config/run-settings.js';
import type { StepResult, TestReport } from '../report/types.js';
import { AiClient } from '../ai/client.js';
import { TokenTracker } from '../utils/tokens.js';
import type { Page } from 'playwright';
import {
  launchBrowser,
  BrowserTracker,
  resolveVideoMode,
  finalizeMainPageVideo,
  briefly,
  type BrowserSession,
  type VideoMode,
} from '../browser/manager.js';
import { executeStep, executeBranchedStep } from '../runner/step-executor.js';
import { identifyStepGroups } from '../runner/step-grouper.js';
import { loadContextFiles } from '../context/loader.js';
import { interpolate } from '../parser/parameters.js';
import { interpolateEnvData, type EnvDataContext } from '../parser/interpolate-env-data.js';
import { resolveDataSourcePath } from '../parser/markdown.js';
import { loadDataFromPath, type DataObject } from '../env/data-loader.js';
import { resolveEnvBundle, type EnvBundle } from '../env/resolve-bundle.js';
import { clearSkillCache, expandSkills, type ExpandedStepOrigin } from '../skills/expander.js';
import { parseToolCall } from '../tools/tool-call-parser.js';
import { executeToolStep } from '../tools/executor.js';
import { loadToolCatalogue, ToolCatalogue } from '../tools/registry.js';
import { formatStepHistoryEntry } from '../ai/prompts.js';
import { captureScreenshot } from '../browser/screenshot.js';
import {
  captureDomSnapshot,
  captureVisibleText,
  domCaptureFailure,
  domSnapshotWasClipped,
  expandDomSubtree,
  toPageCaptureError,
  PageCaptureError,
} from '../browser/dom-cleaner.js';
import { ApiResponseStore } from '../api/response-store.js';
import { parseTimeoutMs } from '../runner/test-runner.js';
import { generateReport, buildReportBaseName } from '../report/generator.js';
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
  config?: { baseUrl?: string; timeout?: string; cdp?: { port: number; tab?: string; profile?: string } };
  steps: string[];
  parameters?: Record<string, string>;
  /**
   * Per-request environment variables (e.g. AI_API_KEY, AI_MODEL). Applied to
   * the session's config only — never written to the server's process.env, so
   * concurrent sessions and the server itself remain isolated. AI_API_KEY /
   * AI_MODEL are re-applied to the session's AiClient at the start of every
   * batch (see `executeStepsInternal`), so a saved `.env` edit is picked up on
   * the next run without closing the session.
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

export type RunEvent =
  | { type: 'step:start'; line: number; frame?: FrameInfo; tab?: TabInfo }
  | { type: 'step:pass'; line: number; output?: string; screenshot?: string; frame?: FrameInfo; fromCache?: boolean; tab?: TabInfo }
  | { type: 'step:fail'; line: number; error: string; screenshot?: string; frame?: FrameInfo; tab?: TabInfo }
  | { type: 'output'; msg: string; kind: 'info' | 'warn' | 'error' }
  | { type: 'capture'; line: number; name: string; value: string; source: 'capture' | 'toolOutput' }
  | {
      type: 'done';
      status: 'passed' | 'failed' | 'error' | 'aborted';
      /** Absolute path of the HTML report, when one was written. Always been on
       *  the wire (spread onto the event by the emitter); declared here now
       *  that `effectiveSettings` sits beside it. */
      reportPath?: string;
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
    }
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

/** How to read the page — see stories/page-content.md §1. */
export interface PageContentOptions {
  format: PageContentFormat;
  /** Restrict the read to the first element matching this CSS selector. */
  selector?: string | undefined;
  /** Hard cap on returned characters. Over-limit content is truncated and
   *  flagged, never silently clipped. */
  maxChars: number;
}

export type PageContentFormat = 'text' | 'dom';

/** The page as read, plus enough context for the caller to know what it got. */
export interface PageContent {
  sessionId: string;
  url: string;
  title: string;
  /** `executing` means a run is in flight and the page may move underneath
   *  the caller — the read is deliberately not queued behind it. */
  status: 'active' | 'executing';
  format: PageContentFormat;
  selector: string | null;
  content: string;
  truncated: boolean;
  returnedChars: number;
  /**
   * Characters the capture produced, before this layer's truncation.
   *
   * A floor, not the page's true size: for `format: 'dom'` the capture is
   * itself bounded by the project's `domSnapshotCharLimit`, so a very large
   * page reports the limit rather than its real length. When that happened,
   * `truncated` is true even if `availableChars <= maxChars` — which is the
   * only signal distinguishing "you got everything" from "you got everything
   * we were willing to capture".
   */
  availableChars: number;
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

/** Settle time before the single retry of a page read that lost to a
 *  navigation. Long enough for a same-document commit, short enough that a
 *  caller waiting on a GET does not notice. */
const NAVIGATION_RETRY_DELAY_MS = 500;

/** One capture's result, plus whether the capture itself already clipped. */
interface CapturedPage {
  text: string;
  /** True when `domSnapshotCharLimit` cut the snapshot before this layer saw
   *  it, so the caller must be told the page is longer than what it received. */
  captureClipped: boolean;
}

/**
 * Slice to at most `max` UTF-16 units without splitting a surrogate pair.
 *
 * `String.prototype.slice` cuts by code unit, so a boundary landing inside an
 * emoji or any astral character leaves a lone high surrogate — which survives
 * `JSON.stringify` but decodes to U+FFFD for whoever reads it. Backing off one
 * unit costs a character and keeps the tail readable.
 */
function sliceWholeCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  const lastUnit = text.charCodeAt(max - 1);
  const endsOnHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return text.slice(0, endsOnHighSurrogate ? max - 1 : max);
}

/** Pattern for [input: variable_name] steps */
const INPUT_STEP_PATTERN = /^\[input:\s*\w+\]/i;

/**
 * Bound on any single page read taken while listing sessions.
 *
 * `GET /sessions` has no deadline of its own, and both reads it performs —
 * `page.title()` and the target-id lookup — can hang on a wedged page. Sized
 * well under `list_sessions`'s own 5 s abort so the caller gets a listing with
 * a blank field rather than a timeout with nothing in it.
 */
const PAGE_READ_TIMEOUT_MS = 1_500;

/** Pattern for [interactive] steps */
const INTERACTIVE_STEP_PATTERN = /^\[interactive\]/i;

/** Pattern for a single [output: variable_name] prefix */
const OUTPUT_PREFIX_PATTERN = /\[output:\s*(\w+)\]/gi;

/** `SessionListItem.cdp` for one session. Reads the retained `sessionConfig`
 *  rather than probing anything — the binding was decided when the session was
 *  created and cannot change afterwards. */
function cdpBinding(session: ManagedSession): SessionListItem['cdp'] {
  const cdp = session.sessionConfig.cdp;
  if (cdp === undefined) return null;
  return { port: cdp.port, profile: cdp.profile ?? null };
}

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
  /** The MAIN page captured at session creation — needed to read its
   *  `video()` handle at closeSession time, since the active page may have
   *  shifted via openBrowser/switchBrowser. Tier 1 records the main page only. */
  mainPage: Page;
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
    /** Absolute path of the already-written report HTML (overwritten in place). */
    reportPath: string;
    /** Run outcome — drives retain-on-failure deletion. */
    passed: boolean;
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
  /** `cdp` is retained, not just consumed at launch: without it `list_sessions`
   *  cannot say which session is driving a persistent signed-in browser, and
   *  the answer is unrecoverable afterwards. It was always assigned here — the
   *  old type simply hid it. */
  sessionConfig: {
    baseUrl?: string;
    timeout?: string;
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
 * Build an AiConfig with optional env overrides applied over a base. Only
 * `apiKey` and `model` are honoured today — these are the env knobs a `.env`
 * shipped from a client realistically wants to override. Always pass the server
 * base config (`this.config.ai`) as `baseConfig`, never a session's current
 * config: overrides apply only on non-empty values, so basing on the fixed
 * server config lets a removed `.env` line revert cleanly instead of sticking
 * on the prior override. Server process.env is never mutated.
 *
 * **Always returns a fresh object, even with nothing to apply.** It used to
 * return `baseConfig` itself on the no-overrides path, which handed
 * `new AiClient(...)` a reference to the SERVER's `config.ai` — and `syncAuth`
 * mutates its config in place, so a model change on one session rewrote the
 * server's startup model for every session created afterwards. Caught live: a
 * `runSettings.model` override on one session moved `GET /config`'s reported
 * server base with it, which is exactly the process-wide leak the whole feature
 * is scoped to avoid. Copying is what keeps the sessions isolated; nothing here
 * relies on the identity.
 */
function applyEnvToAiConfig(
  baseConfig: import('../config/types.js').AiConfig,
  envOverrides: Record<string, string> | undefined,
): import('../config/types.js').AiConfig {
  const next = { ...baseConfig };
  if (!envOverrides) return next;
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

  /** Backing store for `runsInFlight()`. See `executeSteps`. */
  private activeRuns = 0;

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

  constructor(config: Config) {
    this.config = config;
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
    // `runsInFlight` pins the idle-shutdown timer (story server-lifecycle §3).
    // Incremented at the very entry of a run — before session creation and
    // before the per-session queue — so every phase counts, including setup
    // and a run queued behind another. Decremented in a `finally` so a throw
    // or an abort can never strand the counter above zero, which would
    // silently disable the idle timeout for the rest of the process's life.
    this.activeRuns++;
    try {
      return await this.executeStepsUncounted(sessionId, request, onEvent, signal);
    } finally {
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

    // Create session if it does not exist. The session's AiClient is built with
    // the per-request env applied here; on a reused session, `AI_MODEL` /
    // `AI_API_KEY` are re-applied per batch in `executeStepsInternal` so a saved
    // `.env` edit takes effect on the next run.
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
            return await this.executeStepsInternal(session, sessionId, request, onEvent, signal);
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
            if (!this.lastRunInfo.get(sessionId)?.finalized) {
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
   */
  async getPageContent(sessionId: string, opts: PageContentOptions): Promise<PageContent | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'closed') {
      return null;
    }

    const page = session.browserSession.pageTracker.getActive();

    let captured: CapturedPage;
    try {
      captured = await this.capturePage(page, session, opts);
    } catch (err) {
      // One retry, for the one failure that is genuinely transient: the read
      // raced a navigation. Everything else propagates immediately — retrying
      // a wedged page or a bad selector just doubles the wait.
      if (!(err instanceof PageCaptureError) || err.kind !== 'navigated') throw err;
      await new Promise((r) => setTimeout(r, NAVIGATION_RETRY_DELAY_MS));
      captured = await this.capturePage(page, session, opts);
    }

    const raw = captured.text;
    const availableChars = raw.length;
    // Two independent clips, and BOTH have to reach the caller. `captureClipped`
    // is the one that bites silently: captureDomSnapshot enforces the project's
    // domSnapshotCharLimit before this layer ever sees the string, so a page
    // clipped there arrives looking complete. An agent told `truncated: false`
    // on a quarter of a page will report that the rest of it does not exist —
    // and raising `max_chars` past the project limit turns a correct warning
    // into a confident wrong answer.
    const truncated = captured.captureClipped || availableChars > opts.maxChars;
    const content = availableChars > opts.maxChars
      ? sliceWholeCodePoints(raw, opts.maxChars)
      : raw;

    // Best-effort, unlike the content itself: an unreadable title is not the
    // answer to the question that was asked, so it degrades to '' rather than
    // failing a read that otherwise succeeded.
    let url = '';
    let title = '';
    try {
      url = page.url();
      title = await page.title();
    } catch {
      // Browser may be in an intermediate state.
    }

    return {
      sessionId,
      url,
      title,
      status: session.status === 'executing' ? 'executing' : 'active',
      format: opts.format,
      selector: opts.selector ?? null,
      content,
      truncated,
      returnedChars: content.length,
      availableChars,
    };
  }

  /** Dispatch one capture. Failures arrive as `PageCaptureError` whichever
   *  path produced them — some throw, some report in band. */
  private async capturePage(
    page: Page,
    session: ManagedSession,
    opts: PageContentOptions,
  ): Promise<CapturedPage> {
    if (opts.format === 'text') {
      const text = await captureVisibleText(page, { selector: opts.selector });
      return { text, captureClipped: false };
    }

    // Both DOM paths report failure in band — `expandDomSubtree` catches its
    // own evaluate, and `captureDomSnapshot` catches all of its except
    // `injectFrameContent`, which runs outside its try. The try/catch below is
    // defensive rather than load-bearing for expand today; it stays because an
    // unclassified throw would bypass the navigation retry and land as a bare
    // 500, and that contract should not depend on a helper never changing.
    if (opts.selector !== undefined) {
      let expanded: string;
      try {
        expanded = await expandDomSubtree(page, opts.selector);
      } catch (err) {
        throw toPageCaptureError(err, 'DOM capture', true);
      }
      const failure = domCaptureFailure(expanded, 'expand');
      if (failure) throw failure;
      // No clip flag: expandDomSubtree does not apply domSnapshotCharLimit, so
      // what it returns is the whole subtree (see stories/page-content.md §2).
      return { text: expanded, captureClipped: false };
    }

    // Project settings, not the server's — see `ManagedSession.browserConfig`.
    let snapshot: string;
    try {
      snapshot = await captureDomSnapshot(page, {
        ...session.browserConfig.domNoiseReduction,
        maxIframeDepth: session.browserConfig.maxIframeDepth,
        domSnapshotCharLimit: session.browserConfig.domSnapshotCharLimit,
      });
    } catch (err) {
      throw toPageCaptureError(err, 'DOM capture');
    }
    const failure = domCaptureFailure(snapshot, 'snapshot');
    if (failure) throw failure;
    return { text: snapshot, captureClipped: domSnapshotWasClipped(snapshot) };
  }

  /** Max distinct sessions we remember finalized-run info for (bounded growth). */
  private static readonly LAST_RUN_INFO_LIMIT = 200;

  /**
   * Record the finalized-run info for a session (issue 021). Bounded LRU-ish:
   * re-inserting moves the key to the end; we evict the oldest once over the cap.
   */
  private recordLastRun(sessionId: string, info: LastRunInfo): void {
    this.lastRunInfo.delete(sessionId);
    this.lastRunInfo.set(sessionId, info);
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
  getLastRun(sessionId: string): LastRunInfo {
    return (
      this.lastRunInfo.get(sessionId) ?? {
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

    const session = this.sessions.get(sessionId);
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
        const page = session.browserSession.pageTracker.getActive();
        let currentUrl = '';
        try {
          currentUrl = page.url();
        } catch {
          // ignore — a closed page still has a session row worth reporting
        }

        const [pageTitle, tab] = await Promise.all([
          briefly(
            (async () => {
              try {
                return await page.title();
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
                return await session.browserSession.pageTracker.activeTabRef();
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
   * the close guard. Sessions are filtered by port first, so a project running
   * launch-mode sessions pays nothing — those are on disposable browsers with
   * no CDP port and can never hold a tab of this one.
   *
   * **Only this server's sessions are visible.** A tab driven by another
   * Sessions API server, or by a human clicking in the window, is unknowable
   * from here — consistent with the standing decision that parallel users of
   * one CDP browser own the consequences.
   */
  async sessionsByTarget(port: number): Promise<SessionsByTarget> {
    const byTarget = new Map<string, string>();
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
          for (const sweep of perBrowser) {
            if (!sweep.complete) complete = false;
            for (const targetId of sweep.ids) {
              // First writer wins. Two sessions can legitimately hold the same
              // tab (they share the browser's context), and for both callers —
              // a listing label and a refusal — naming one is enough.
              if (!byTarget.has(targetId)) byTarget.set(targetId, id);
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
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

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
          stableBaseName: buildReportBaseName(pending.report),
          closeContext,
        });
        if (savedAbs) {
          try {
            // POSIX-style relative path so <video src> resolves cross-OS.
            pending.report.videoRelPath = pathRelative(session.reportOutputDir, savedAbs)
              .split(sep)
              .join('/');
            await generateReport(pending.report, session.reportOutputDir);
            logger.info(`Report re-rendered with session video: ${pending.reportPath}`);
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
    sessionConfig: { baseUrl?: string; timeout?: string; cdp?: { port: number; tab?: string; profile?: string } } | undefined,
    envOverrides: Record<string, string> | undefined,
    /** Resolved per-project record mode (from the test's `browser.video`). */
    videoMode: VideoMode,
    /** Absolute, project-anchored output dir — reports, videos, and the run log
     *  all land under here (see resolveSessionOutput). */
    reportOutputDir: string,
  ): Promise<ManagedSession> {
    logger.info(`Creating session "${sessionId}"`);

    // Apply per-request env to a fresh ai config copy. Server's process.env is
    // never mutated; concurrent sessions stay isolated.
    const aiConfig = applyEnvToAiConfig(this.config.ai, envOverrides);

    // Video recording (Tier 1 — main page only). Thread the videos/ dir so the
    // launched context records when the resolved per-project `videoMode` isn't
    // 'off'. Under CDP launchBrowser short-circuits before newContext, so
    // nothing records.
    const videoDir = pathJoin(reportOutputDir, 'videos');
    // Override only `video` with the per-project record mode; the rest of the
    // browser config stays server-global. videoDir is co-located with where
    // reports are written (the project-anchored reportOutputDir) so the report's
    // relative <video> link resolves.
    const browserSession = await launchBrowser(
      { ...this.config.browser, video: videoMode },
      sessionConfig?.cdp,
      { videoDir },
    );
    const browserTracker = new BrowserTracker(browserSession);

    // Everything past the browser launch can throw (notably an invalid baseUrl
    // makes page.goto reject) — and the session isn't registered in
    // `this.sessions` until the very end, so a throw here would orphan the
    // just-launched browser: the caller's later closeSession(sessionId) finds
    // nothing to close and the window leaks. Tear the browser down on any
    // setup failure before re-throwing so the error still surfaces but no
    // browser is left behind.
    try {
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
        mainPage: browserSession.page,
        videoMode,
        reportOutputDir,
        videoDir,
        status: 'active',
        // Startup defaults until the first batch resolves the project's own.
        browserConfig: this.config.browser,
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
        deadSectionsReported: new Set<string>(),
      };

      this.sessions.set(sessionId, session);
      return session;
    } catch (err) {
      logger.warn(
        `Session "${sessionId}": creation failed after browser launch — closing the orphaned browser. ${err instanceof Error ? err.message : String(err)}`,
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
  ): Promise<StepResponse> {
    session.status = 'executing';

    // Re-apply the per-request env (.env) AI overrides to this session's client
    // so a saved AI_MODEL / AI_API_KEY edit is picked up on the next run without
    // closing the session. Recomputed from the server base (`this.config.ai`),
    // NOT the session's current values, so deleting a line from `.env` cleanly
    // reverts to the base rather than sticking on the last override. This runs
    // at the top of the `queueTail`-serialized body (not in `executeSteps`,
    // which resolves the session before queuing) so it can never mutate the
    // shared AiClient config out from under a concurrent in-flight batch.
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
    const aiChange = session.aiClient.syncAuth(desiredModel, desiredAi.apiKey);
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
    this.lastRunInfo.delete(sessionId);
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
    // Retain the project's browser settings for out-of-band reads
    // (`getPageContent`), which have no test file to re-resolve a bundle from.
    session.browserConfig = projectConfig.browser;

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
    const resolvedSettings = resolveRunSettings(
      this.config,
      projectConfig,
      desiredAi.model,
      session.runSettings,
    );
    const runConfig = resolvedSettings.config;
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
    const toolCatalogue = session.toolCatalogue;

    // Skill expansion — when the caller supplies `skillsDir`, flatten
    // `[skill: ...]` lines into their bodies before execution and remember
    // the per-step origin so step-into-aware clients see `frame:push` /
    // `frame:pop` events around each skill body. Without `skillsDir` the
    // existing flow is preserved verbatim (raw steps shipped to the runner).
    if (request.skillsDir || hasSections(request)) {
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

        // Check if this step is part of a conditional group
        const group = stepGroups.get(i);
        if (group && i === group.conditionalSteps[0]!.index) {
          logger.info(`Session "${sessionId}": conditional group at step ${i + 1}`);

          let branchedResults: StepResult[];
          try {
            branchedResults = await executeBranchedStep(group, stepsTotal, {
              page: session.browserSession.pageTracker.getActive(),
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
              pageTracker: session.browserSession.pageTracker,
              browserTracker: session.browserTracker,
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

        emit({ type: 'step:start', line: sourceLineFor(i), ...frameSpread, ...(await tabSpread()) });

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
                pageTracker: session.browserSession.pageTracker,
                browserTracker: session.browserTracker,
                ...(stepCache && { stepCache }),
                cacheEnabled:
                  cacheEnabledForRequest &&
                  !!stepCache &&
                  // See `isSubsetBatch`: a non-root frame's key is not stable
                  // across batches, so neither read nor write is safe here.
                  !(isSubsetBatch && (expansionOrigins?.[i]?.frameId ?? '') !== ''),
                cacheKey: stepCacheKey,
                // No interactive console attached to a server-driven run —
                // an AI clarification prompt must fail the step fast rather
                // than block on stdin and hang the stream. See issues/014.
                nonInteractive: true,
                // Run abort signal — cancels in-flight AI calls and stops the
                // step's turn loop the instant the client stops. See issues/020.
                ...(signal && { signal }),
              },
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

        // Collect per-step output captures from resolvedParameters. Union
        // explicit `[output: X]` declarations with every `as` name this
        // step's own successful read/count actions used — auto-surfaced even
        // with no `[output:]` prefix on the instruction (issue 042).
        // Restricted to read/count (the only actions that write `as` into
        // resolvedParameters — see step-executor.ts) with no `.error`, for
        // two reasons: (1) other `as` uses aren't captures at all — e.g.
        // openPage's tab-label `as` shares the same namespace but never
        // writes resolvedParameters, and extract_value's `as` is currently a
        // documented no-op sub-action; (2) resolvedParameters persists
        // across steps, so an unfiltered failed action's `as` could still be
        // `in resolvedParameters` from an *earlier* step and wrongly emit a
        // stale value attributed to this one. `__skill*`-namespaced names are
        // always excluded — those are skill-internal (see the `__skill*`
        // invariant at session-manager.ts ~2063 / expander.ts) and must never
        // reach session.outputs/captures or leak into the next batch's seed.
        const autoOutputVars = stepResult.turns
          .flatMap((t) => t.subActions)
          .filter((sa) => !sa.error && (sa.action.action === 'read' || sa.action.action === 'count'))
          .map((sa) => sa.action.as)
          .filter((name): name is string => !!name && !name.startsWith('__skill'));
        const captureVars = new Set([...outputVars, ...autoOutputVars]);

        const stepOutputs: Record<string, string> = {};
        for (const varName of captureVars) {
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

        fullStepResults.push({
          ...stepResult,
          index: i + 1,
          instruction: originalStep,
          ...(Object.keys(stepOutputs).length > 0 && { outputs: stepOutputs }),
          ...(sourceSkill && { sourceSkill }),
          ...(sourceSection && { sourceSection }),
          ...tabAfterStep,
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
        const failedSteps = fullStepResults.filter((s) => s.status === 'failed' && !s.interrupted).length;
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
        const report: TestReport = {
          testName,
          filePath: fileForName,
          tags: [],
          status: reportStatus,
          steps: fullStepResults,
          totalSteps: stepsTotal,
          passedSteps,
          failedSteps,
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
        };
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
      } catch (err) {
        logger.warn(`Failed to generate HTML report for session "${sessionId}": ${String(err)}`);
      }
    }

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

    emit({
      type: 'done',
      status: overallStatus,
      ...(reportPath && { reportPath }),
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
