import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'node:path';
import {
  ApiClient,
  ApiClientError,
  EnvParseError,
  isUserAbort,
  classifySelectedSteps,
  matchText,
  composeEnv,
  extractSections,
  extractSteps,
  danglingChainMemberError,
  resolveRunSelection,
  sectionBodyLinesAt,
  interpretReplCommand,
  maskIfSecretAuthored,
  parseConfig,
  parseFrontmatter,
  parseDataRows,
  scanSectionDataTables,
  parseParameters,
  readEnvFile,
  readEnvOverlayFile,
  readMachineKey,
  reportError,
  describeStepFailure,
  isSkippedPass,
  resolveEnvFile,
  resolveSection,
  userRootEnvPath,
  type ClassifiedStep,
  type CompileEvent,
  type CompileProgressEvent,
  type CompileSummary,
  type DataRowStatus,
  type ErrorPayload,
  type FrameInfo,
  type HostRowsMsg,
  type HostToWebviewMsg,
  type RunEvent,
  type ScopeMasking,
  type StepMode,
} from 'ai-ui-automation-runner-core';
import { getOutputChannel } from './output-channel.js';
import { skipCompileLogLine, skipRunLogLine } from './step-skip-core.js';
import { runLogTallyLine } from './steps-summary-core.js';
import { deliberateRunLogLine, toleratedRunLogLine } from './failure-outcome-core.js';
import { compileResultLine } from './compile-summary-core.js';
import type { CompileTail } from './compile-progress-core.js';
import type { CompileTailSignals } from './compile-tail-signals.js';
import { EnvSelector } from './env-selector.js';
import { resolveProjectDirs } from './aiui-config.js';
import {
  buildSectionsPayload,
  preflightSections,
  sectionedSkillRefusal,
  SectionNarrowingError,
} from './sections.js';
import { decideViewportRecycle } from './viewport-recycle.js';
import {
  rowFailureDetail,
  rowFailureError,
  rowSkipDetail,
  rowSkipHover,
  rowStatusFromLineStatus,
  rowStoppedHover,
  withRunRowsNote,
  worseRowStatus,
  type RowSkipReason,
  type RowTableKind,
} from './row-summary-core.js';
import {
  calledSectionNames,
  chainMembersKeptLogLine,
  failedRowsFrom,
  oldServerBodyStepsWarning,
  rowOutcomeLine,
  rowValuesText,
  rowsSummaryLine,
  sectionRowsIgnoredLogLine,
  sectionRowsLogLine,
  sectionRowsResumedLogLine,
  sectionStepsIgnoredLogLine,
  sectionStepsLogLine,
  sectionStepsResumedLogLine,
  splitBodySteps,
  stepRangeText,
  stepsPerRowLogLine,
} from './row-selection-core.js';
import {
  decideServerAction,
  defaultHealthProbe,
  defaultServerSpawner,
  isLoopbackUrl,
  readAutoStartSettings,
  startServerAndWait,
  HEALTH_PROBE_TIMEOUT_MS,
  type AutoStartConfig,
  type AutoStartGuard,
  type HealthProbe,
  type ServerSpawner,
} from './server-manager.js';

/**
 * Subset of the ApiClient surface we depend on. Defining it lets tests
 * inject a fake that scripts the event stream without spinning up the
 * real Sessions API server. The default factory still hands back a real
 * `new ApiClient(...)` for production use.
 */
export interface ApiClientLike {
  streamSteps(
    sessionId: string,
    request: unknown,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent>;
  closeSession(sessionId: string): Promise<void>;
  /** Optional in tests that predate Phase 3 — when absent, run-control
   *  commands are no-ops. The real ApiClient implements this against
   *  `POST /sessions/:id/run-control`. */
  runControl?(
    sessionId: string,
    mode: StepMode,
    opts?: { pauseAtNextTool?: boolean; pauseAtNextCodeBehind?: boolean },
  ): Promise<void>;
  /** Optional Phase-5 ack used by tool step-into. Tests that don't
   *  exercise the tool-debugger flow omit it. */
  ackToolDebugger?(sessionId: string): Promise<void>;
  /** Optional liveness probe (`GET /sessions/:id`). Used by the "re-run a
   *  skill step" path to refuse before reusing a dead session. When absent
   *  (older fakes) the re-run treats the session as live. */
  isSessionAlive?(sessionId: string): Promise<boolean>;
  /** Optional (issue 021): the last finalized run's report path + token totals
   *  (`GET /sessions/:id/last-run`). Polled on STOP to recover what the dropped
   *  `done` event would have carried. Absent on older clients/fakes → the stop
   *  path simply skips recovery. Returns null on an older server (404). */
  getLastRun?(sessionId: string): Promise<LastRunInfoLike | null>;
  /** Optional: render a data-driven run's one report from the rows the server
   *  accumulated (`POST /sessions/:id/report`). Absent on older clients and on
   *  fakes that never loop, in which case a row run simply leaves no report —
   *  the rows themselves still ran. */
  finalizeRowReport?(
    sessionId: string,
    notRun: Array<{ row: number; values: Record<string, string>; reason: string }>,
  ): Promise<{ reportPath: string } | null>;
  // No `compileCodeBehind` here any more. The extension compiles through the
  // ordinary step route now (stories/compile-as-you-go.md); the boxed
  // `POST /codebehind/compile` pipeline stays server-side for `aiui compile`,
  // where a headless caller has no diff to click.
}

/** Shape returned by {@link ApiClientLike.getLastRun} (mirrors runner-core). */
export interface LastRunInfoLike {
  finalized: boolean;
  tokens?: { total: number; input: number; output: number };
  reportPath?: string;
}

export type ApiClientFactory = (config: { serverUrl: string; apiKey: string }) => ApiClientLike;

/** Default factory — the real one. */
export const defaultApiClientFactory: ApiClientFactory = (config) => new ApiClient(config);

/**
 * Keep-alive cadence while paused at a breakpoint (§3). Comfortably under any
 * sane idle timeout (the suggested one is 60 minutes) while costing one cheap
 * authenticated GET per interval.
 */
const KEEP_ALIVE_INTERVAL_MS = 5 * 60_000;

/** Outcome of the pre-run server phase. `proceed` covers both "it's ours" and
 *  the legacy/skip paths — from the run's point of view they are the same
 *  instruction, and only the log line differs. */
type ServerReadiness =
  | { kind: 'proceed' }
  | { kind: 'aborted' }
  | { kind: 'fail'; payload: ErrorPayload };

/** Outcome reported back to callers — used by tests + commands. */
export interface RunOutcome {
  ok: boolean;
  error?: ErrorPayload;
  /**
   * What a compile-mode run proposed (stories/compile-as-you-go.md). Present
   * only when the run carried `compile`; absent when the stream ended without
   * a `compile:result`, which an older server would do.
   */
  compile?: CompileOutcome;
}

/**
 * What a compile came back with (stories/codebehind-compile.md).
 *
 * `files` is present only on a green compile, and is the whole proposed
 * content of each `.steps.ts` — the diff's right-hand side. `summary` rides
 * along on both outcomes because a red compile still has something to say:
 * how many rounds it spent, what it cost, and where it left the candidate.
 */
export interface CompileOutcome {
  /** True when there is something to propose — green or partial. */
  ok: boolean;
  /** `green`, `partial` (some entries proven, some not — see the summary),
   *  or `failed`. Absent when the stream never produced a result. */
  status?: 'green' | 'partial' | 'failed';
  files?: Record<string, string>;
  summary?: CompileSummary;
  error?: string;
}

/** What `resolveClient` hands back: a client plus enough about its target
 *  to log it and to name it in an error. */
interface ResolvedClient {
  client: ApiClientLike;
  sessionId: string;
  serverUrl: string;
  /** Prose for the log: where `serverUrl` came from. */
  source: string;
  /** The .env the URL was read from, or null when it is the last run's. */
  envPath: string | null;
}

/** Phase labels for the run log, matching `aiui compile`'s output. */
const COMPILE_PHASE_LABEL: Record<string, string> = {
  record: 'Record',
  select: 'Select',
  generate: 'Generate',
  review: 'Review',
  replay: 'Replay',
  repair: 'Repair',
  write: 'Write',
};

/**
 * One run-log line per compile event, or null for the ones that say nothing a
 * reader needs — `compile:result` is the payload, and its narrative already
 * arrived as `compile:done`.
 */
export function compileLogLine(event: CompileEvent): string | null {
  switch (event.type) {
    case 'compile:phase': {
      const label = event.round
        ? `${COMPILE_PHASE_LABEL[event.phase] ?? event.phase} ${event.round}`
        : COMPILE_PHASE_LABEL[event.phase] ?? event.phase;
      return `  ${label.padEnd(11)} ${event.message}`;
    }
    case 'compile:step':
      // `step: 0` is the Review pass, which belongs to the file rather than to
      // any step — and on a compile-mode run there is no phase line above it
      // to sit under, so it carries its own label.
      return event.step > 0
        ? `  ${' '.repeat(11)} step ${event.step} ${event.message}`
        : `  ${(COMPILE_PHASE_LABEL[event.phase] ?? event.phase).padEnd(11)} ${event.message}`;
    case 'compile:run': {
      // The run's own pass/fail lines, indented under the phase they belong
      // to. Starts and the run's `done` say nothing the phase line did not.
      const inner = event.event;
      if (inner.type === 'step:pass') {
        // A step the compile's run decided against — the untaken branch of a
        // chain, which a compile is allowed to contain — did not run, so it
        // gets the same `◌` (`SKIP_GLYPH`) the interactive run log gives it
        // rather than a ✓, with the reason a current server sends alongside.
        if (isSkippedPass(inner)) {
          return `  ${' '.repeat(11)} ${skipCompileLogLine(inner.line, inner.reason)}`;
        }
        const how = inner.codeBehindStale
          ? ` ⚠ under AI — code-behind failed: ${inner.codeBehindStale.error}`
          : inner.fromCodeBehind
            ? ' (code-behind)'
            : inner.fromCache
              ? ' (cached)'
              : '';
        return `  ${' '.repeat(11)} ✓ step on line ${inner.line}${how}`;
      }
      if (inner.type === 'step:fail') {
        // Replay runs strict, so a red step here IS the code-behind failing —
        // but say so only when the event does, in the same words every other
        // single-line surface uses.
        //
        // Unless the step tolerated it, in which case the round carried on and
        // the entry proved nothing either way (decision 11). ⚠, so the compile
        // log reads the way the gutter beside it paints.
        if (inner.tolerated) {
          return `  ${' '.repeat(11)} ⚠ step on line ${inner.line} failed — continuing: ${describeStepFailure(inner)}`;
        }
        return `  ${' '.repeat(11)} ✗ step on line ${inner.line} — ${describeStepFailure(inner)}`;
      }
      // A round that returned never reached the rest of that flow. Said out
      // loud, because it is the difference between "this entry is unproven"
      // and "this entry failed" — and the compile's own status (`partial`)
      // only says the first of those about the file as a whole.
      if (inner.type === 'step:skip') {
        return `  ${' '.repeat(11)} ${skipCompileLogLine(inner.line, inner.reason)}`;
      }
      if (inner.type === 'output') return `  ${' '.repeat(11)} [${inner.kind}] ${inner.msg}`;
      return null;
    }
    case 'compile:progress':
      // Numbers for the strip, the toast and the status bar item — never a log
      // line. The prose that belongs beside them already arrived as the
      // `compile:step` start frame this event accompanies.
      return null;
    case 'compile:done':
      return event.status === 'green'
        ? `✓ ${event.message}`
        : event.status === 'partial'
          ? `◐ ${event.message}`
          : `✗ ${event.message}`;
    case 'output':
      return `[${event.kind}] ${event.msg}`;
    default:
      return null;
  }
}

/**
 * The one line a compile-mode run leaves in the log when its result arrives —
 * re-exported so this module stays the run stream's renderer while the
 * WORDING lives in a vscode-free core the fast suite can pin
 * (`compile-summary-core.ts`).
 */
export { compileResultLine };

/** Everything the "re-run this skill step with its variables" action needs,
 *  captured when a step inside a TOP-LEVEL skill fails. */
export interface SkillFailure {
  /** Server frame id of the failed (top-level) skill invocation. */
  frameId: string;
  /**
   * What kind of frame failed.
   *
   * A top-level SECTION frame has `parentId === null` — the same shape as a
   * top-level skill invocation — so it flows through the capture path
   * unchanged. But everything downstream assumed "skill": for a section,
   * `skillUri` is the TEST file, so the skill-file-oriented
   * debug-after-Stop flow would half-activate against it, and the "does this
   * skill define sections?" refusal would reject every section re-run (a test
   * file with a section by definition defines sections).
   *
   * Nothing to gate on existed before this field.
   */
  kind: 'skill' | 'section';
  /** Skill or section name, for the panel heading. */
  skillName: string;
  /** Absolute path of the file the failed step lives in — the skill file for
   *  a skill, the test file itself for a section. */
  skillUri: string;
  /** The failed step's 1-based line within the skill file. */
  skillLine: number;
  /** The test file that owns the `[skill: …]` invocation. */
  testUri: vscode.Uri;
  /** The `[skill: …]` invocation's 1-based line in the test file. */
  testLine: number;
}

/** The single "debug a skill after Stop" context held by the registry — the
 *  stopped test whose skill the user is iterating on. Derived from a
 *  `SkillFailure` at Stop time; at most one at a time (latest Stop wins).
 *  See stories/specs/skill-debug-after-stop.md. */
export interface SkillDebugContext {
  /** The test that owns the `[skill: …]` invocation — session key + routing. */
  testUri: vscode.Uri;
  /** The `[skill: …]` invocation's 1-based line in the test file. */
  testLine: number;
  /** Absolute path of the skill file being debugged. */
  skillUri: string;
  /** Skill name, for the status-bar banner. */
  skillName: string;
  /** Server frame id of the failed top-level invocation. */
  frameId: string;
}

/** One row of a data table, as the controller tracks it through a run. */
interface RowState {
  /** 1-based table position — the number every surface names the row by. */
  row: number;
  /** 1-based editor line the row occupies. */
  line: number;
  /** `"k=v, k=v"`, masked. Built once, by `rowValuesText`
   *  (row-selection-core.ts) through `maskIfSecretAuthored` — a row's column
   *  headings are author-chosen — so the gutter hover, the panel and the
   *  Output banner cannot word it differently. */
  values: string;
  status: DataRowStatus;
  detail?: string;
  /** The gutter hover — the long form of `detail`. */
  hover?: string;
  durationMs?: number;
  /**
   * Is this row part of THIS run?
   *
   * Every row of every table on a whole-file run; only the chosen ones when a
   * selection narrowed an axis. The difference is what decision 6 turns on:
   * an unselected row is untouched — it keeps the mark it already had and is
   * never painted `skip`, because skip means "was going to run and did not"
   * and a hover saying so would lie about this run.
   */
  planned: boolean;
  /**
   * The worst TERMINAL state this row reached in the whole run, and the run
   * rows it reached it on.
   *
   * A section table inside a data-driven run is looped once per run row, so
   * `status` is repeatedly reset to `running` at the start of each iteration —
   * which is what makes the band follow the loop, and which also wipes a
   * failure from three run rows back the moment a later run row starts. The
   * merge cannot live in `status` for that reason; it lives here, and
   * `finalizeRowTables` paints it once the loop is over (§"Across run rows").
   */
  worst?: {
    status: DataRowStatus;
    detail?: string;
    hover?: string;
    /** The 1-based RUN rows this status was reached on; empty outside a
     *  data-driven run, where there is no run row to name. */
    runRows: number[];
  };
}

/**
 * The step failure a row (or a section iteration) died at.
 *
 * `sourceUri` is the fsPath of the file the failing step LIVES in, taken from
 * the event's frame, and it is present only when that is not the test
 * document. Without it a failure inside a `[skill:]` body was described by
 * reading the test file at the skill's line number: a skill-body failure on
 * line 12 read as `Row 3 failed at step 2 — "<whatever the test's line 12
 * says>"`, which is a step the row may never have run.
 */
interface RowFailure {
  line: number;
  error: string;
  sourceUri?: string;
}

/** The file a row's failure came from, named the way a reader would name it —
 *  `login.md`. `undefined` when it came from the test document itself, which
 *  is the case that gets an ordinal and a quoted step instead. */
function basenameOfSource(sourceUri: string | undefined): string | undefined {
  return sourceUri === undefined ? undefined : path.basename(sourceUri);
}

/** One data table of the document, and the state of its rows. */
interface RowTableState {
  /** The wire discriminator: `'run'` or `{ section }`. */
  table: 'run' | { section: string };
  /** `'run'` counts rows, `'section'` counts iterations — one word, every
   *  string this table produces. */
  kind: RowTableKind;
  headerLine: number;
  rows: RowState[];
}

/**
 * One controller per .md test document. Owns the abort controller for the
 * active run; refuses to start a second run while one is in flight.
 *
 * The extension keeps a Map<URI, RunController> in run-controller-registry,
 * lazily creating controllers as files are opened. Each controller posts
 * run events to a `post` callback (which routes to the sidebar webview).
 */
export class RunController {
  private active: AbortController | null = null;
  /** Incremented per run; lets a background post-stop report poll (issue 021)
   *  detect that a newer run started and skip clobbering its report path. */
  private runGeneration = 0;
  private lastResolvedEnvPath: string | null = null;
  private configSentForSession = false;
  /**
   * WHICH viewport spec the live session was created with — the value that
   * rode its (write-once) `config` block, or `null` when that block carried no
   * `viewport` key. Only meaningful while `configSentForSession` is true, so
   * the two always move together: every write goes through `markConfigSent` /
   * `forgetSentConfig` rather than assigning the flag directly.
   *
   * Read by the recycle-on-change gate at the top of a run
   * (stories/per-test-viewport.md §5): config cannot be re-sent to a session
   * the server already created, so a changed viewport can only take effect by
   * closing that session first.
   */
  private viewportSentForSession: string | null = null;
  /**
   * Whether this controller PROBABLY has a live server session: a steps
   * stream has answered since the last close/recycle. The truth is the
   * server's — callers that act on a session still run the
   * `isRerunSessionLive` pre-flight — but enumeration (the skill-file
   * session picker) needs a no-network signal for "worth listing".
   * Controller-lifetime only: a session that survived a window reload is
   * invisible here until this window runs the test again.
   */
  get sessionProbablyOpen(): boolean {
    return this.configSentForSession;
  }
  /** The `compile:result` a compile-mode run produced, collected as the
   *  stream folds and attached to the outcome by `runLines`. Reset per run,
   *  so a plain Run after a Run & Compile never carries the old proposal. */
  private compileResult: CompileOutcome | undefined;
  /** Bumped by every call that gets PAST the `isRunning` guard. `runLines`
   *  compares it to decide whether the proposal on the field is this call's
   *  to claim — see the wrapper. */
  private compileToken = 0;
  /** The compile mode of the logical run in progress, so a Continue after a
   *  breakpoint keeps compiling rather than silently becoming a plain Run. */
  private compileModeOfRun: 'run' | 'steps' | undefined;
  /**
   * The compile tail's strip state for THIS document, or null when no tail is
   * running (stories/compile-tail-progress.md §The panel strip).
   *
   * Held on the controller — which is per document — rather than in the
   * webview, so switching away and back mid-tail restores the strip at the
   * current count instead of losing it. The panel is one surface shared by
   * every controller; the strip is one file's news.
   */
  private compileStrip: CompileTail | null = null;
  /**
   * Has this run's server sent any `compile:progress` frame?
   *
   * The one thing that tells a current server from an older one, and it has to
   * be a fact rather than a guess: generation starts while the run is still
   * executing later steps, so a `compile:step` frame is NOT evidence the tail
   * has begun — on a current server it is routinely mid-run. The server emits
   * the progress frame ahead of the prose for exactly this reason, so by the
   * time a `compile:step` arrives this flag is already true there.
   */
  private sawCompileProgress = false;
  /** Read by the registry when this file becomes active again, to re-post the
   *  strip the webview may never have been told about. */
  get compileTailState(): CompileTail | null {
    return this.compileStrip;
  }
  /**
   * The workbench-level aggregator (status bar item + one toast per compile).
   * Attached by the registry after construction rather than taken in the
   * constructor, which already has eight positional parameters — and a batch
   * controller deliberately gets none, for the same reason it posts nowhere.
   */
  private tailSignals: CompileTailSignals | undefined;
  attachCompileTailSignals(signals: CompileTailSignals): void {
    this.tailSignals = signals;
  }
  /** Test-only readback of the remembered mode. A Stop clearing it has no
   *  other observable effect — every path that would inherit is already gated
   *  on `isResume`, and a Stop wipes the resume marker — so without this the
   *  clear could rot untested. */
  get rememberedCompileMode(): 'run' | 'steps' | undefined {
    return this.compileModeOfRun;
  }
  /**
   * Did the run that just finished park at a breakpoint (or a pause)?
   *
   * Read by Run & Compile to decide whether to open the diff yet: a parked run
   * has not finished compiling, and its proposal is about to grow. Recorded
   * here rather than read back off the tracker's snapshot, which derives its
   * own `breakpointStop` from state a failed run can also leave behind.
   */
  private parkedAtPause = false;
  private pendingPrompt: { resolve: (text: string | null) => void } | null = null;
  /** Set by pause() so the abort handler knows to mark a resume point
   *  rather than treating the abort as a full Stop. */
  private pauseRequested = false;
  /** Line of the most recent step:start event in the current run. Used as
   *  the resume point when the user pauses mid-step. */
  private lastStepStartLine: number | null = null;
  /** Absolute path of the HTML report from the most recently *completed*
   *  run (pass or fail). Set on `done` events that include `reportPath`,
   *  unchanged otherwise — so a paused-and-never-resumed run leaves the
   *  previous report openable. Server omits the field when the run
   *  produced no step results or report generation failed; null is the
   *  no-report state. */
  private lastResolvedReportPath: string | null = null;

  /** 1-based row being executed, or null outside a data-driven loop. */
  private currentRowNumber: number | null = null;

  /**
   * The matrix a pause left parked, or null when no run is parked.
   *
   * A pause ends the loop after the current row (rows story, decision 6), and
   * that row is NOT finished: a breakpoint trimmed its steps, so half of them
   * ran. Painting it `passed` — which is what happened before, five times over
   * for a five-row test — claims the whole test passed while the pause arrow
   * sits on step 4. So the row keeps its band and this remembers the matrix
   * until the Continue of that run settles it, or a Stop paints it ■.
   *
   * `row` is the run row the loop parked in, or null when the run was not a
   * row loop at all — a file whose only table is a section's still has rows
   * mid-flight when a breakpoint parks the run, and its matrix has to survive
   * the Continue for the frames to keep painting into.
   *
   * Outlives the run on purpose: the Continue is a separate `runLines` call.
   */
  private parkedRowState: { row: number | null } | null = null;

  /**
   * The row a batch runner should prefix its failure messages with.
   *
   * Read by the Test Explorer, which sees the run only through `onEvent` and
   * so cannot tell five rows failing step 6 apart from five identical
   * failures (§What does not change).
   */
  get currentRow(): number | null {
    return this.currentRowNumber;
  }

  /**
   * How the editor currently paints this document's lines, and what the
   * hovers say — set by the registry, absent for a batch controller (which
   * paints nothing).
   *
   * Read once per run, to seed the rows a narrowed run did NOT select: the
   * row boundary clears the file's statuses and the matrix is what puts them
   * back, so without this an unselected row's ✓ would vanish the first time a
   * neighbour was re-run on its own.
   */
  lineStatuses?: () => Map<number, string>;
  lineHovers?: () => Map<number, string>;

  /** The section-loop narrowings in force for the run in flight, handed to
   *  `buildSectionsPayload` on every block. Undefined outside a narrowed run,
   *  which is what makes the sections payload byte-identical to before. */
  private sectionRowsOfRun: Record<string, number[]> | undefined;

  /** The section-BODY narrowings in force for the run in flight — section name
   *  → 0-based body-step indices — handed to `buildSectionsPayload` as
   *  `runSteps`. Undefined outside a narrowed run, which is what keeps the
   *  sections payload byte-identical to before. */
  private sectionStepsOfRun: Record<string, number[]> | undefined;

  /** Body-step line → the narrowed section it belongs to, for every body line
   *  this run did NOT select. A step event on one of these can only mean the
   *  server ignored `runSteps` and ran the whole body. */
  private unselectedBodyLines = new Map<number, string>();

  /** Each narrowed section's body step texts as they were when the run
   *  started, so a later block can tell that the indices it is about to ship
   *  no longer mean what they meant — plus whether the narrowing covers every
   *  call of that section, which is what the resumed log line has to repeat
   *  and cannot re-derive (a Continue's lines hold no body lines).
   *  Undefined outside a narrowed run. */
  private narrowedBodySnapshot:
    | Record<string, { steps: string[]; everyCall: boolean }>
    | undefined;

  /** Each narrowed section LOOP's authored table size, for the resumed line's
   *  `rows 2 of 3`. The chosen rows live in `sectionRowsOfRun`; this is the
   *  denominator, which nothing else on the run carries. */
  private sectionRowTotalsOfRun: Record<string, number> | undefined;

  /** The one refusal a stale narrowing produces, remembered so it is said once
   *  and so the row loop can tell this failure from an ordinary one: a fact
   *  about the file refuses identically for every row after it. */
  private narrowingRefusal: string | null = null;

  /**
   * The section narrowings a PAUSED run parked, for its Continue to pick up.
   *
   * A continuation rebuilds `lines` as "every main-flow step at or below the
   * pause", which contains no body lines at all — so recomputing the narrowing
   * from it would come back empty, run the whole body, paint the marks the
   * selection excluded, and disarm the old-server detector on the way past.
   * Carried instead, the way `compileModeOfRun` and `parkedRowState` are, and
   * dropped by anything that is not a resume.
   */
  private parkedNarrowing:
    | {
        rows: Record<string, number[]> | undefined;
        rowTotals: Record<string, number> | undefined;
        steps: Record<string, number[]> | undefined;
        unselectedBodyLines: Map<number, string>;
        bodySnapshot: Record<string, { steps: string[]; everyCall: boolean }> | undefined;
      }
    | null = null;

  /** One warning per run about a server that ignored `runSteps`, not one per
   *  body step: like the `rowNumbers` warning, the fact is about the server. */
  private oldServerBodyStepsWarned = false;

  /** Line → the rows that failed on it, for the end-of-loop repaint. */
  private rowFailuresByLine = new Map<number, number[]>();

  /**
   * The live matrix — every data table in the document and the state of each
   * of its rows (stories/data-row-progress-and-selection.md).
   *
   * One structure, two surfaces: it is posted as the `rows` message, which
   * the Runner panel's Rows section renders and the extension host paints
   * into the gutter. Keeping them on one message is what makes the table and
   * the panel incapable of disagreeing.
   *
   * It also has to *survive* the row boundary's `clearStatusesForUris`, which
   * wipes the whole file's statuses so the next row's steps repaint from
   * blank. Re-posting the matrix after that clear is what puts rows 1..n-1's
   * marks back; without the structure there would be nothing to put back.
   */
  private rowTables: RowTableState[] = [];
  /** Wall clock of the run row that is executing, for its `durationMs`. */
  private rowStartedAt: number | null = null;
  /** Frame id → the section-table row that frame is running. Populated from
   *  `frame.iteration`, which the server stamps on every looped body's frame. */
  private sectionIterationFrames = new Map<
    string,
    { section: string; row: number; startedAt: number }
  >();
  /** Section name → how many of its iteration frames this run has seen. Only
   *  consulted for a NARROWED section, where the k-th frame is the k-th row
   *  the client shipped whatever the server called it (`rowForIteration`). */
  private sectionIterationsSeen = new Map<string, number>();
  /** One warning per run about a server that ignored `rowNumbers`, not one
   *  per iteration: the fact is about the server, and three rows would say it
   *  three times. */
  private oldServerNumberingWarned = false;
  /** Frame id → the first `step:fail` seen inside that frame's subtree. Read
   *  on `frame:pop` to say WHICH body step an iteration died at. */
  private frameFailures = new Map<string, RowFailure>();
  /** The failure the current run row died at, for that row's ✗ hover. The
   *  FIRST one wins: it is the step that stopped the row, and the ones after
   *  it (if any) are consequences. */
  private lastFailureThisRow: RowFailure | null = null;
  /** Token totals for the most recently finalized run (issue 021). Set from the
   *  `done` event on a normal run, or recovered via `getLastRun` on STOP (where
   *  the `done` is dropped). null until a run finalizes. */
  private lastRunTokensValue: { total: number; input: number; output: number } | null = null;
  /** False until the first runLines call clears any stale server session
   *  for this file. VS Code reloads create a fresh controller but the
   *  server still has the previous session keyed on the file path — left
   *  unattended, the server can short-circuit the new run with an instant
   *  `done` and no step events, which the runner misreads as "all steps
   *  passed" and pins the pause indicator on the breakpoint line without
   *  any preceding step having actually run. Closing on first use gives a
   *  clean slate; subsequent runs in the same activation reuse the
   *  session as intended. */
  private staleSessionCleared = false;
  /** Per-run event listener, set by runLines via options.onEvent and
   *  cleared in finally. Batch runners hook this to drive TestRun results
   *  without having to subscribe to the host→webview message channel. */
  private currentEventListener: ((event: RunEvent) => void) | null = null;

  /**
   * Stack of frames currently active, most recent on top. Maintained from
   * `frame:push` / `frame:pop` events on the SSE stream when the server
   * supports the step-into protocol. Empty when execution is in the test
   * (top-level) frame. Read by the Call Stack view; written only here.
   */
  private _frameStack: FrameInfo[] = [];
  /** Root attribution for each pushed frame — the (uri, line) in the test
   *  file the descent ultimately started from. Inherited from parent on
   *  nested pushes. Drives the aggregate test-file status on `[skill: ...]`
   *  lines so the user sees pass/fail on those lines even though the actual
   *  step events for the descent land on the skill file's lines.
   *
   *  Persists across the frame's `frame:pop` until end-of-run — a late
   *  `step:fail` event (out-of-order, or from a server that emits pop
   *  before all its descendants' events have drained) still needs to
   *  resolve the root so the failure paints on the test file. Cleared
   *  by `resetFrameState`. */
  private frameRoot = new Map<string, { testUri: vscode.Uri; testLine: number }>();
  /** Parent id for every frame we've seen this run, persistent across the
   *  frame's own `frame:pop`. Used by `markFrameFailed` to walk ancestry
   *  reliably even after the frame has been popped off the live stack. */
  private frameParents = new Map<string, string | null>();
  /** Frame ids whose descent has had a step:fail somewhere underneath.
   *  Propagated to the test-file [skill:] line on `frame:pop`. */
  private failedFrames = new Set<string>();
  /** URIs auto-revealed this run, so we don't keep re-revealing the same
   *  skill file each time its first step starts. Per-controller (not
   *  per-registry) so two test files running in sequence both reveal
   *  shared skills independently. Cleared by `resetFrameState` at the
   *  start of each run. */
  private readonly revealedFrameUris = new Set<string>();
  /** Skill-file URIs whose stale statuses have already been wiped on first
   *  descent THIS run. Distinct from `revealedFrameUris` (which gates the
   *  editor auto-reveal): a shared skill needs its prior-run marks cleared
   *  the first time the current run steps into it, so a different test
   *  reusing the skill doesn't inherit the other test's ✓/✗. Cleared by
   *  `resetFrameState`. */
  private readonly clearedDescentUris = new Set<string>();
  /** True while the in-flight run is a Continue/Resume continuation. The
   *  descent-clear is suppressed for these — a continuation must preserve
   *  the marks painted before the pause. */
  private currentRunIsContinuation = false;
  /** Captured at the start of each run so step-control commands
   *  (sendRunControl) can target the right session via POST. Cleared in
   *  the `runLines` finally block. */
  private currentClient: ApiClientLike | null = null;
  private currentSessionId: string | null = null;
  /** Session id of the current/most-recent run. Like `currentSessionId` but NOT
   *  cleared at run end, so out-of-band ops (closeSession, getLastRun,
   *  isSessionAlive) target the right session — critically the batch post-run
   *  close, which fires after the run. Interactive runs reuse the stable
   *  file-path id; batch runs get a unique `<path>::run-N` so two runs of the
   *  same file are two distinct server sessions (see the batch-session-id issue). */
  private activeSessionId: string | null = null;
  /** Captured along with currentClient so the tool step-into feature can
   *  test whether the server is reachable as a Node debugger target.
   *  Cleared in the same finally block. */
  private currentServerUrl: string | null = null;
  /** Server connection the most-recent run actually targeted. Unlike
   *  `currentServerUrl` (run-scoped, nulled at run end), these PERSIST past the
   *  run so out-of-band lifecycle ops (closeSession, the re-run liveness probe,
   *  getLastRun) follow the same server the run used — critical once a selected
   *  env's `.env.<name>` can override SERVER_URL/AIUI_SERVER_API_KEY away from base
   *  `.env`. Null before the first run, when `resolveClient` falls back to disk. */
  private lastRunServerUrl: string | null = null;
  private lastRunApiKey: string | null = null;
  /**
   * `inspector` from the pre-run health probe, run-scoped like
   * `currentServerUrl`. Three distinct states, and §7 treats each differently:
   *   - a ws:// URL ⇒ attach there;
   *   - `null`      ⇒ the server HAS no inspector; do not attach blindly;
   *   - `undefined` ⇒ no health data at all (legacy server) ⇒ settings fallback.
   * `undefined` is therefore NOT a synonym for null and must survive as its
   * own value.
   */
  private currentInspectorUrl: string | null | undefined = undefined;
  /** Timer pinning the server while this run is paused at a breakpoint. */
  private keepAliveTimer: ReturnType<typeof setInterval> | undefined;

  /** Latest variable scope emitted by `frame:scope` per frame id. The
   *  test (root) frame uses key '' to match the server-side convention.
   *  Cleared by `resetFrameState` at the start of each run. */
  private readonly scopesByFrame = new Map<string, Record<string, string>>();
  /**
   * What the same `frame:scope` event said about how to READ that scope —
   * which of its dotted names a `For each` pass bound, and which names the
   * test's `## Config: unmask:` declares are not secrets
   * (docs/specs/SPEC-structured-table-reads.md §7.6).
   *
   * Beside `scopesByFrame` rather than inside it, so `scopeFor` keeps handing
   * back the plain `Record<string, string>` the skill-re-run seed and the
   * test hooks already read. Per frame for the same reason the scope is:
   * every emit carries both, and a frame that never got one has nothing to
   * say — which the maskers read as "older server", their pre-wire default.
   */
  private readonly scopeMaskingByFrame = new Map<string, ScopeMasking>();
  private readonly scopeEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever any frame's scope is updated. The Variables view
   *  subscribes — bridged through the registry so a single subscriber
   *  catches every controller's transitions. */
  readonly onScopeChange = this.scopeEmitter.event;
  private readonly frameStackEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever `frameStack` changes. The Call Stack view subscribes. */
  readonly onFrameStackChange = this.frameStackEmitter.event;

  constructor(
    public readonly document: vscode.TextDocument,
    public readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly post: (msg: HostToWebviewMsg) => void,
    private readonly clientFactory: ApiClientFactory = defaultApiClientFactory,
    /**
     * Optional provider for the full per-URI breakpoint map shipped to
     * the server on every steps request (Phase 5 follow-up — skill-file
     * breakpoint support). The registry passes a closure over its
     * tracker; tests pass a fixed map or omit entirely.
     */
    private readonly breakpointsByUriProvider?: () => Record<string, number[]>,
    /**
     * Optional sink for clearing tracker statuses on a list of URIs at
     * the start of every run. Without this, statuses from a prior run
     * persist on lines that the new run never reaches — most visible
     * when a skill failure short-circuits the test: the trailing test
     * step's old `pass` tick stays painted even though it didn't
     * execute, which reads as "the test continued past the failure."
     * The registry passes a closure over its tracker; tests can omit.
     */
    private readonly clearStatusesForUris?: (uris: vscode.Uri[]) => void,
    /**
     * Optional hook fired at the start of a fresh (non-continuation) run. The
     * registry uses it to drop a parked skill-debug context owned by this test:
     * a full re-run from the top supersedes a stopped-skill debug session.
     */
    private readonly onFreshRunStart?: () => void,
    /**
     * Injectable delay for the post-stop report poll (issue 021). Defaults to a
     * real timer; tests pass an instant resolver so the poll is deterministic
     * and not wall-clock-bound.
     */
    private readonly pollSleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    /**
     * Server-lifecycle collaborators (story server-lifecycle §5), grouped
     * rather than appended as three more positionals — the parameter list was
     * already long enough that both call sites had to pass `undefined`
     * placeholders to reach past `pollSleep`.
     *
     * `healthProbe`/`spawnServer` are injected rather than called directly
     * because the electron harness fakes the server through `clientFactory`;
     * a raw `fetch` or a real spawn in the run path would escape the fake.
     */
    private readonly server: {
      healthProbe?: HealthProbe;
      spawnServer?: ServerSpawner;
      /** Absolute path of the rolling log a spawned child writes to
       *  (`<globalStorage>/server.log`). Absent ⇒ auto-start is unavailable,
       *  since there would be nowhere to send the child's output — and that
       *  output is the only diagnosis a failed start leaves behind. */
      logPath?: () => string;
      /** Breakpoint-pause keep-alive cadence. Injectable so a test can assert
       *  the PING, not merely that a timer exists — an empty interval body
       *  would otherwise pass while the idle shutdown reaped the session the
       *  user was paused in. */
      keepAliveIntervalMs?: number;
      /** Shared across every controller (the registry owns one), so a failed
       *  auto-start is not retried once per test in a batch run. */
      autoStartGuard?: AutoStartGuard;
      /** Cadence of the spawn health poll. Its own knob rather than reusing
       *  `pollSleep` (the post-stop report backoff): those are unrelated
       *  concerns, and a test that made the report poll instant — which its
       *  own doc comment invites — would silently turn this into a
       *  wall-clock-bounded busy-spin issuing thousands of probes. */
      pollSleep?: (ms: number) => Promise<void>;
      /**
       * Called once per run, after the pre-run health phase resolves to
       * "proceed" and before any session/steps request — the seam the
       * `.steps.ts`-breakpoint auto-attach hangs off
       * (stories/codebehind-debugging.md). `inspectorUrl` is what /health
       * reported (`null` = server has no inspector, `undefined` = no health
       * data / legacy server — the settings fallback applies). Injected like
       * `healthProbe` because the harness cannot exercise a real
       * `vscode.debug.startDebugging`; failures are the hook's to swallow —
       * a run must never break because an attach did.
       */
      onServerReady?: (info: {
        inspectorUrl: string | null | undefined;
        /** The run's resolved SERVER_URL — the hook's loopback check, since
         *  attaching a LOCAL debugger for a REMOTE server is the
         *  wrong-process bug §7 exists to prevent. */
        serverUrl: string;
        log: (line: string) => void;
      }) => Promise<void> | void;
    } = {},
  ) {}

  private get healthProbe(): HealthProbe {
    return this.server.healthProbe ?? defaultHealthProbe;
  }

  private get spawnServer(): ServerSpawner {
    return this.server.spawnServer ?? defaultServerSpawner;
  }

  get isRunning(): boolean {
    return this.active !== null;
  }

  /** Did the run that just finished park at a breakpoint or a pause? A parked
   *  compile has not finished — Continue sends the rest of the test, and the
   *  proposal it produces is the one to show. */
  get isParkedAtPause(): boolean {
    return this.parkedAtPause;
  }

  get lastEnvPath(): string | null {
    return this.lastResolvedEnvPath;
  }

  get lastReportPath(): string | null {
    return this.lastResolvedReportPath;
  }

  /** Token totals for the most recently finalized run (issue 021), or null. */
  get lastRunTokens(): { total: number; input: number; output: number } | null {
    return this.lastRunTokensValue;
  }

  /** Read-only view of the active frame stack. Empty when execution is in
   *  the test (top-level) frame. The top of the stack is the deepest frame. */
  get frameStack(): readonly FrameInfo[] {
    return this._frameStack;
  }

  /**
   * Consume a frame event from the SSE stream. Pushes/pops the frame stack,
   * tracks root attribution for the aggregate test-file [skill:] status,
   * and fires `onFrameStackChange`. Called by the extension's per-run
   * router (`applyToTracker`) so the controller stays the source of truth
   * for frame state, even though the router does the side-effect work
   * (decorations, editor reveal).
   *
   * Returns `{ failed }` on a `frame:pop` so the caller can update the
   * test-file aggregate status — `true` if any descendant step failed
   * during this frame's lifetime, `false` for a clean exit.
   */
  handleFramePush(frame: FrameInfo): void {
    this._frameStack.push(frame);
    // Root attribution: top-level skills (parentId is the test root, i.e.
    // null) anchor themselves on the test file. Nested skills inherit the
    // same root so a deep failure still marks the outermost `[skill:]`
    // line in the test.
    const root = frame.parentId
      ? this.frameRoot.get(frame.parentId)
      : { testUri: this.document.uri, testLine: frame.line };
    if (root) this.frameRoot.set(frame.id, root);
    // Remember ancestry for `markFrameFailed` to walk after the frame has
    // been popped (the live stack alone isn't enough when step:fail and
    // frame:pop arrive close together).
    this.frameParents.set(frame.id, frame.parentId);
    // A looped section's frame carries the table position it is running
    // (`iteration`), which is the only thing that knows which row of the
    // section's table to band. Paints and posts; a frame without it is an
    // ordinary descent and this is a no-op.
    this.startSectionIteration(frame);
    this.frameStackEmitter.fire();
  }

  handleFramePop(frameId: string): { failed: boolean; root: { testUri: vscode.Uri; testLine: number } | null } {
    const idx = this._frameStack.findIndex((f) => f.id === frameId);
    const failed = this.failedFrames.has(frameId);
    const root = this.frameRoot.get(frameId) ?? null;
    if (idx >= 0) {
      // Pop this frame and anything pushed above it. Nested-skill servers
      // emit pops in the right order, but defending against truncated
      // streams keeps the UI from showing a phantom frame after stop/abort.
      this._frameStack.length = idx;
    }
    // Deliberately keep frameRoot / frameParents populated until run end:
    // a late step:fail (after pop) needs ancestry to propagate the failure
    // to the test file's [skill:] line. resetFrameState clears them.
    //
    // The iteration's row is closed out here for the same reason the
    // aggregate `[skill:]` status is: the pop is the only event that says the
    // body is done. Pass, or fail with the body step it died at.
    this.endSectionIteration(frameId);
    this.frameStackEmitter.fire();
    return { failed, root };
  }

  /** The test-file invocation a frame descends from, or null if unknown.
   *  Recorded on every `frame:push` and kept until run end, so it answers
   *  for popped frames too. The event router reads it to pair a section-body
   *  pause with the invocation Continue has to re-enter through. */
  rootOfFrame(frameId: string): { testUri: vscode.Uri; testLine: number } | null {
    return this.frameRoot.get(frameId) ?? null;
  }

  /** Mark a frame as having had a failed descendant step. Walks the parent
   *  chain via the persistent `frameParents` map so the root frame (the one
   *  anchored on the test file's `[skill:]` line) inherits the failure even
   *  if the immediate step that failed lives several levels deep AND even
   *  if the frame has already been popped off the live stack. */
  markFrameFailed(frameId: string): { testUri: vscode.Uri; testLine: number } | null {
    let cur: string | null = frameId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      this.failedFrames.add(cur);
      cur = this.frameParents.get(cur) ?? null;
    }
    return this.frameRoot.get(frameId) ?? null;
  }

  /**
   * Where a user Pause should resume from when it landed inside a section
   * body, or null when it didn't (in which case the caller keeps the
   * pre-existing invocation-line behaviour).
   *
   * The pause path is the odd producer out: it reads the live frame stack
   * rather than a parked failure, so it needs its own derivation rather than
   * reuse of `recordSkillFailure`'s. Both halves of the test are load-bearing:
   *
   *  - the frame gate (`section`, top-level, defined by THIS file) keeps
   *    nested sections and skill-file sections on today's path, where line
   *    anchors aren't safe;
   *  - re-checking `lastStepStartLine` against the buffer closes the window
   *    where a frame has been pushed but its first step has not started. In
   *    that window the last `step:start` was still a MAIN-FLOW line, and
   *    calling it a body line would resume a completely different step.
   */
  private sectionPauseAt(
    topFrame: FrameInfo | undefined,
    text: string,
  ): { bodyLine: number; callLine: number } | null {
    if (!topFrame) return null;
    if (topFrame.kind !== 'section' || topFrame.parentId !== null) return null;
    if (topFrame.uri !== this.document.uri.fsPath) return null;
    const root = this.frameRoot.get(topFrame.id);
    if (!root) return null;
    const bodyLine = this.lastStepStartLine;
    if (bodyLine == null) return null;
    if (!sectionBodyLinesAt(text, bodyLine).includes(bodyLine)) return null;
    return { bodyLine, callLine: root.testLine };
  }

  /** Reset the frame stack — called on run start so a fresh run never
   *  inherits leftover frames from an aborted or completed previous run. */
  resetFrameState(): void {
    this._frameStack = [];
    this.frameRoot.clear();
    this.frameParents.clear();
    this.failedFrames.clear();
    this.revealedFrameUris.clear();
    this.clearedDescentUris.clear();
    this.sectionIterationFrames.clear();
    this.sectionIterationsSeen.clear();
    this.frameFailures.clear();
    this.lastFailureThisRow = null;
    this.scopesByFrame.clear();
    this.scopeMaskingByFrame.clear();
    // The parked skill failure's seed scope lives in scopesByFrame, which we
    // just wiped — drop the failure too so the re-run affordance can't offer a
    // stale, unseedable retry.
    this._lastSkillFailure = null;
    this.frameStackEmitter.fire();
    this.scopeEmitter.fire();
  }

  /**
   * Record a `frame:scope` event for one frame. Called by the extension
   * router (`applyToTracker`) so the controller owns the per-frame scope
   * map and the Variables view has a single source of truth. Fires
   * `onScopeChange` so subscribers re-render.
   */
  handleFrameScope(
    frameId: string,
    scope: Record<string, string>,
    /**
     * The event's `bindings` / `unmask`, forwarded verbatim — including the
     * difference between an EMPTY `bindings` and a missing one. Empty says
     * this run bound nothing, so every dotted entry is the author's and takes
     * the flat rule; missing says an older server, which leaves the maskers
     * on their pre-wire reading. Collapsing the two would mask `AU` out of a
     * real loop's `row.keyword` against an old server, or keep printing
     * `user.apikey` against a new one.
     */
    masking: ScopeMasking = {},
  ): void {
    // Copy the payload — the SSE deserialiser shares the object across
    // listeners and mutating downstream would surprise others.
    this.scopesByFrame.set(frameId, { ...scope });
    this.scopeMaskingByFrame.set(frameId, {
      ...(masking.bindings !== undefined && { bindings: [...masking.bindings] }),
      ...(masking.unmask !== undefined && { unmask: [...masking.unmask] }),
    });
    this.scopeEmitter.fire();
  }

  /** Latest scope for a frame, or undefined if none has been emitted
   *  this run. The Variables view reads this when the user selects a
   *  frame in the Call Stack (future Phase 4.B); today we render the
   *  top frame's scope as the "current" view. */
  scopeFor(frameId: string): Record<string, string> | undefined {
    return this.scopesByFrame.get(frameId);
  }

  /** Captured when a step inside a TOP-LEVEL skill fails — the context the
   *  "re-run this skill step with its variables" action needs. null when no
   *  re-runnable skill failure is parked. Cleared by `resetFrameState` (any new
   *  run) and `clearSkillFailure` (Stop / Close Session). Nested-skill failures
   *  are out of scope for v1 and are not recorded. */
  private _lastSkillFailure: SkillFailure | null = null;

  /** The parked re-runnable skill failure, or null. The Variables view gates
   *  its edit-and-re-run affordance on this. */
  get lastSkillFailure(): SkillFailure | null {
    return this._lastSkillFailure;
  }

  /** Record a `step:fail` that occurred inside a skill frame, IF that frame is
   *  a top-level invocation (`parentId === null`). `failedLine` is the step's
   *  1-based line in the skill file. Called by the run-event router.
   *
   *  UNHANDLED KIND: `FrameInfo.kind` now includes `'section'`, and a section
   *  invoked from the main flow has `parentId === null` — the same shape as a
   *  top-level skill. This function gates on `parentId` alone, so such a
   *  frame would be parked as a `SkillFailure` whose `skillUri` is the *test*
   *  file, and the Variables panel would offer "re-run this skill step" for
   *  something that is not a skill.
   *
   *  Deliberately not guarded here. No section frame can reach this yet (the
   *  server has no sections wiring until PR-3), and a blanket
   *  `kind !== 'skill'` refusal is the wrong fix — it would refuse every
   *  section re-run, which the sections runtime spec wants to work. The
   *  decision belongs with `SkillFailure.kind` in the native-runtime PR;
   *  `call-stack-view.ts`'s `?? 'skill'` label and `symbol-method` icon are
   *  the same class. */
  recordSkillFailure(frame: FrameInfo, failedLine: number): void {
    // v1: top-level frames only — a nested skill or section is out of re-run
    // scope, same as before sections existed.
    if (frame.parentId !== null) return;
    // The root (test) frame itself is not a re-runnable unit: there is no
    // enclosing invocation to re-enter, and `skillUri` would be the test file
    // with no section or skill to name.
    //
    // Today the `!root` guard below already refuses it — the root frame's id
    // is `''`, which is never registered in `frameRoot` (only a `frame:push`
    // populates it, and the root is synthesized without one). This explicit
    // kind gate does not depend on that coupling: it states the intent
    // directly, so a future change to how `frameRoot` is populated can't
    // silently start parking a root-frame failure with the test file as its
    // `skillUri`.
    if (frame.kind !== 'skill' && frame.kind !== 'section') return;
    const root = this.frameRoot.get(frame.id);
    if (!root) return;
    this._lastSkillFailure = {
      frameId: frame.id,
      kind: frame.kind,
      skillName: frame.skillName ?? frame.kind,
      skillUri: frame.uri,
      skillLine: failedLine,
      testUri: root.testUri,
      testLine: root.testLine,
    };
  }

  /**
   * Variables-panel payload for the parked skill failure, or null if none. The
   * scope is the captured frame scope minus `__skill*` internals; `paramNames`
   * are the skill's declared parameters (rendered read-only — they're baked
   * into the step text at expansion, so editing them here wouldn't take
   * effect). Best-effort: a missing/unreadable skill file just yields no
   * param names (all rows editable).
   */
  skillRerunPayload(): { testUri: string; skillName: string; scope: Record<string, string>; paramNames: string[] } | null {
    const failure = this._lastSkillFailure;
    if (!failure) return null;
    const captured = this.scopeFor(failure.frameId) ?? {};
    const scope: Record<string, string> = {};
    for (const [k, v] of Object.entries(captured)) {
      if (!k.startsWith('__skill')) scope[k] = v;
    }
    let paramNames: string[] = [];
    try {
      paramNames = Object.keys(parseParameters(fs.readFileSync(failure.skillUri, 'utf8')));
    } catch {
      // best-effort — skill file unreadable; leave all rows editable
    }
    return { testUri: failure.testUri.toString(), skillName: failure.skillName, scope, paramNames };
  }

  /** Forget any parked skill failure — its scope is gone (resetFrameState) or
   *  the user explicitly tore the run down (Stop / Close Session). */
  clearSkillFailure(): void {
    this._lastSkillFailure = null;
  }

  /**
   * Re-run a parked top-level skill failure from the failed step to the end of
   * the skill, on the live session, seeding the captured scope plus `edits`.
   * `edits` overrides captured values by their (caller-visible) name; `__skill*`
   * internals are never seeded — they're re-minted per expansion and can't be
   * restored, and the server refuses a tail that needs one. Returns the run
   * outcome (a no-op `{ ok: false }` if nothing is parked). The caller runs the
   * liveness pre-flight (`isRerunSessionLive`) BEFORE this — so a dead session
   * is refused without tearing down the parked failure here. The partial-run
   * request wiring lives in `runLines`'s `rerun` option.
   */
  async rerunSkillStepFromFailure(edits: Record<string, string> = {}): Promise<RunOutcome> {
    const failure = this._lastSkillFailure;
    if (!failure) {
      vscode.window.setStatusBarMessage('TestBench: no failed skill step to re-run', 2500);
      return { ok: false };
    }
    const unsupported = sectionedSkillRefusal(failure);
    if (unsupported) {
      vscode.window.setStatusBarMessage(unsupported, 6000);
      return { ok: false };
    }
    // Seed = captured frame scope (minus server-owned __skill* internals) with
    // the user's edits overlaid. Read it BEFORE runLines, which calls
    // resetFrameState and wipes scopesByFrame + the parked failure.
    // `edits` arrives from an untrusted webview message; tolerate a malformed
    // payload rather than throw in Object.entries.
    const safeEdits = edits && typeof edits === 'object' ? edits : {};
    const captured = this.scopeFor(failure.frameId) ?? {};
    const seedScope: Record<string, string> = {};
    for (const [k, v] of Object.entries(captured)) {
      if (!k.startsWith('__skill')) seedScope[k] = v;
    }
    for (const [k, v] of Object.entries(safeEdits)) {
      if (!k.startsWith('__skill') && typeof v === 'string') seedScope[k] = v;
    }
    return this.runLines([failure.testLine], {
      isContinuation: true,
      rerun: {
        startAt: { uri: failure.skillUri, line: failure.skillLine },
        seedScope,
      },
    });
  }

  /** The scope of the currently-active (top) frame, or the test frame's
   *  scope if execution is at the root. Used by the Variables view's
   *  "show the running scope" default. */
  currentScope(): Record<string, string> {
    const topId = this._frameStack[this._frameStack.length - 1]?.id ?? '';
    return this.scopesByFrame.get(topId) ?? this.scopesByFrame.get('') ?? {};
  }

  /** How to READ the scope {@link currentScope} returns — the `bindings` and
   *  `unmask` of the event that delivered it. Falls back the same way
   *  `currentScope` does (top frame, then the test frame), so the two always
   *  describe the same payload; `{}` when nothing has arrived, which the
   *  maskers read as an older server and answer as they did before. */
  currentScopeMasking(): ScopeMasking {
    const topId = this._frameStack[this._frameStack.length - 1]?.id ?? '';
    return this.scopeMaskingByFrame.get(topId) ?? this.scopeMaskingByFrame.get('') ?? {};
  }

  /** Atomic test-and-mark: returns true the first time a URI is seen this
   *  run, false on subsequent calls. Caller uses the return value to gate
   *  the auto-reveal side-effect so the same skill file isn't re-opened
   *  on every `step:start` inside it. */
  shouldRevealFrameUri(uri: string): boolean {
    if (this.revealedFrameUris.has(uri)) return false;
    this.revealedFrameUris.add(uri);
    return true;
  }

  /** Atomic test-and-mark: returns true the first time the current run
   *  descends into `uri`, so the caller can wipe statuses a PREVIOUS run
   *  (possibly a different test sharing the skill) left on that file.
   *  Returns false on repeat descents and false for continuation runs,
   *  which must keep the marks painted before the pause. */
  shouldClearDescentStatuses(uri: string): boolean {
    if (this.currentRunIsContinuation) return false;
    if (this.clearedDescentUris.has(uri)) return false;
    this.clearedDescentUris.add(uri);
    return true;
  }

  /**
   * Send a step-control command to the server, advancing a step-paused
   * run. No-op when nothing is running, when the active client doesn't
   * support runControl (legacy / test fakes), or when the request fails.
   *
   * The matching SSE stream is still open and will continue emitting
   * events once the server picks up the new mode.
   *
   * Phase 3.1.c — error reporting is split:
   *   - `not-found` (HTTP 409 in disguise) means there's no paused run
   *     to deliver to. Common race when the user mashes F11 between
   *     events. Silent — the next event from the stream will tell the
   *     user where they actually are.
   *   - everything else (connect-failed, server-error) gets a status-
   *     bar diagnostic so the user knows the server side actually
   *     failed, not just a UX race.
   */
  async sendRunControl(
    mode: StepMode,
    opts?: { pauseAtNextTool?: boolean; pauseAtNextCodeBehind?: boolean },
  ): Promise<void> {
    const client = this.currentClient;
    const sessionId = this.currentSessionId;
    if (!client || !sessionId) return;
    if (typeof client.runControl !== 'function') return;
    try {
      await client.runControl(sessionId, mode, opts);
    } catch (err) {
      const isNotFound =
        err !== null &&
        typeof err === 'object' &&
        'kind' in err &&
        (err as { kind?: string }).kind === 'not-found';
      if (isNotFound) {
        // Benign race: no paused run on the server side. Don't bother the
        // user — they'll see the next event in a moment.
        return;
      }
      const reason = err instanceof Error ? err.message : String(err);
      vscode.window.setStatusBarMessage(
        `TestBench: run-control failed (${reason})`,
        2500,
      );
    }
  }

  /** `inspector` reported by the pre-run health probe. See the field's doc
   *  for why `null` and `undefined` are different answers. */
  get inspectorUrl(): string | null | undefined {
    return this.currentInspectorUrl;
  }

  /** Test-only: is the breakpoint-pause keep-alive armed? A leaked timer
   *  would pin the server open indefinitely, which no assertion on a 5-minute
   *  interval could catch in a test. */
  get keepAliveActive(): boolean {
    return this.keepAliveTimer !== undefined;
  }

  /**
   * Pre-run server check + auto-start (story server-lifecycle §5).
   *
   * Runs after env resolution has produced SERVER_URL and before any session
   * is created. The run's AbortController already exists, so Stop cancels a
   * wedged health wait or spawn poll — and an abort during this phase is an
   * `aborted` run, never a TB028.
   *
   * The full decision tree, in order:
   *   2. healthy + service matches ⇒ proceed, remember `inspector`.
   *   3. service mismatch          ⇒ TB027. Never spawn on a foreign port.
   *   4. reachable, unidentifiable ⇒ proceed on the LEGACY path. An older
   *      aiui server whose Express 404s /health is indistinguishable from a
   *      foreign one by this probe, so we neither spawn nor refuse; the
   *      authenticated calls that follow sort it out via the TB01x mapping.
   *   5. down, but remote / unconfigured ⇒ proceed and let the existing
   *      TB010 path report it (with the new settings hint).
   *   6. down + localhost + configured  ⇒ spawn, then poll until healthy.
   *
   * Returns `null` to proceed, or an ErrorPayload the caller fails the run
   * with. `aborted: true` means the user pressed Stop mid-phase.
   */
  private async ensureServerReady(args: {
    serverUrl: string;
    signal: AbortSignal;
    log: (line: string) => void;
  }): Promise<ServerReadiness> {
    const { serverUrl, signal, log } = args;
    this.currentInspectorUrl = undefined;

    const probe = await this.healthProbe(serverUrl, HEALTH_PROBE_TIMEOUT_MS, signal);
    if (signal.aborted) return { kind: 'aborted' };

    const action = decideServerAction(
      serverUrl,
      probe,
      readAutoStartSettings(vscode.workspace.getConfiguration('testbench-native')),
    );

    switch (action.kind) {
      case 'proceed':
        this.currentInspectorUrl = action.health.inspector;
        // However it got here — our spawn or the user's own terminal — the
        // server is up, so a recorded failure is stale. Leaving it would let
        // a later crash be met with "a previous attempt failed moments ago"
        // and suppress a spawn that would now succeed.
        this.server.autoStartGuard?.clear(serverUrl);
        log(
          `server healthy at ${serverUrl}` +
            (action.health.version ? ` (v${action.health.version})` : '') +
            `, inspector=${action.health.inspector ?? 'none'}`,
        );
        return { kind: 'proceed' };

      case 'refuse-foreign':
        log(`TB027 ${serverUrl} is served by "${action.service}"`);
        return { kind: 'fail', payload: reportError('TB027', { serverUrl, service: action.service }) };

      case 'legacy':
        // `currentInspectorUrl` stays undefined, which is what routes tool
        // step-into to the settings fallback (§7.4).
        log(
          `server at ${serverUrl} answered but did not identify itself (${action.detail}) — ` +
            'proceeding on the legacy path (may be an aiui server predating /health)',
        );
        return { kind: 'proceed' };

      case 'skip':
        // Not ours to start. Let the run proceed so the existing TB010
        // connect-failure path reports it, with its new settings hint. The
        // probe's own reason goes in the line — refused, unresolvable and
        // timed out are different problems with different fixes.
        log(
          `server down at ${serverUrl}` +
            (probe.kind === 'down' ? ` (${probe.detail})` : '') +
            ` — not auto-starting (${action.reason})`,
        );
        return { kind: 'proceed' };

      case 'spawn': {
        // A start that just failed is not retried per-test. In a Test
        // Explorer batch every test re-runs this phase, so a broken command
        // would otherwise spawn one detached shell per test and stall the
        // whole batch for readyTimeoutSeconds each time.
        if (this.server.autoStartGuard?.isSuppressed(serverUrl)) {
          log(`server down at ${serverUrl} — auto-start was already tried and failed recently`);
          return {
            kind: 'fail',
            payload: reportError('TB028', {
              serverUrl,
              reason:
                'a previous auto-start attempt failed moments ago, so this run did not retry it. ' +
                'Fix the command (or start the server yourself) and run again',
              ...(this.server.logPath && { logPath: this.server.logPath() }),
            }),
          };
        }
        const outcome = await this.autoStartServer({
          serverUrl,
          autoStart: action.config,
          signal,
          log,
        });
        if (outcome.kind === 'proceed') this.server.autoStartGuard?.clear(serverUrl);
        return outcome;
      }
    }
  }

  /**
   * §5.6 — spawn, wait for health, and translate the outcome into the run's
   * vocabulary. The spawn/poll policy itself lives in `startServerAndWait`
   * so the Start Server command runs exactly the same sequence.
   */
  private async autoStartServer(args: {
    serverUrl: string;
    autoStart: AutoStartConfig;
    signal: AbortSignal;
    log: (line: string) => void;
  }): Promise<ServerReadiness> {
    const { serverUrl, autoStart, signal, log } = args;

    const result = await startServerAndWait({
      serverUrl,
      config: autoStart,
      logPath: this.server.logPath?.(),
      probe: this.healthProbe,
      spawn: this.spawnServer,
      sleep: this.server.pollSleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      signal,
      log,
    });

    switch (result.kind) {
      case 'ready':
        this.currentInspectorUrl = result.health.inspector;
        log(`server came up at ${serverUrl}, inspector=${result.health.inspector ?? 'none'}`);
        return { kind: 'proceed' };
      case 'aborted':
        return { kind: 'aborted' };
      case 'foreign':
        // Something else grabbed the port while we were starting.
        return {
          kind: 'fail',
          payload: reportError('TB027', { serverUrl, service: result.service }),
        };
      case 'refused':
        log(`TB028 refusing to spawn — ${result.reason}`);
        return { kind: 'fail', payload: reportError('TB028', { serverUrl, reason: result.reason }) };
      case 'timeout':
        log(`TB028 server did not become healthy within ${result.seconds}s`);
        // ONLY this arm arms the backoff. The refusals above never spawned
        // anything and cost nothing to re-evaluate — latching them would mean
        // a user who fixed a blank `cwd` got told, for the next minute, that
        // "a previous attempt failed" about a command that never ran.
        this.server.autoStartGuard?.recordFailure(serverUrl);
        return {
          kind: 'fail',
          payload: reportError('TB028', {
            serverUrl,
            reason: `it did not become healthy within ${result.seconds}s`,
            logPath: result.logPath,
            ...(result.logTail && { logTail: result.logTail }),
          }),
        };
    }
  }

  // -------------------------------------------------------------------------
  // Breakpoint-pause keep-alive (§3)
  // -------------------------------------------------------------------------

  /**
   * Pin the server while this run sits paused at a breakpoint.
   *
   * A breakpoint pause is CLIENT-side: the batch is truncated at the
   * breakpoint, the server finishes it, and the session sits with no run in
   * flight — invisible to the server's `runsInFlight` counter, and therefore
   * to the idle shutdown. A cheap authenticated request every few minutes
   * bumps the server's activity timestamp, which is the other half of the
   * idle definition. `/health` deliberately would NOT work here: it is
   * unauthenticated and never touches the timer.
   *
   * Idempotent — a second call while already running is a no-op, so repeated
   * pauses can't stack timers.
   */
  private startKeepAlive(target?: { client: ApiClientLike; sessionId: string }): void {
    if (this.keepAliveTimer) return;
    // `target` is for the pause that happens BEFORE the run's client exists
    // (a breakpoint on the very first step): the session it pins belongs to a
    // previous run that is still open on the server.
    const client = target?.client ?? this.currentClient;
    const sessionId = target?.sessionId ?? this.currentSessionId;
    if (!client || !sessionId || typeof client.isSessionAlive !== 'function') return;

    this.keepAliveTimer = setInterval(() => {
      // Best-effort: a failed keep-alive means the session or server is gone,
      // which the resume will report properly. Nothing to say here.
      void client.isSessionAlive?.(sessionId).catch(() => undefined);
    }, this.server.keepAliveIntervalMs ?? KEEP_ALIVE_INTERVAL_MS);
    this.keepAliveTimer.unref?.();
  }

  /**
   * Run `body` with the server pinned, releasing the ping afterwards.
   *
   * For pauses that sit INSIDE the run loop (an `[input:]` prompt), where
   * there is a natural end to the wait — unlike a breakpoint pause, which
   * ends the run and is released by the next run or a stop.
   */
  private async withKeepAlive<T>(body: () => Promise<T>): Promise<T> {
    const alreadyRunning = this.keepAliveTimer !== undefined;
    this.startKeepAlive();
    try {
      return await body();
    } finally {
      // Don't tear down a keep-alive we didn't start.
      if (!alreadyRunning) this.stopKeepAlive();
    }
  }

  /** Stop the keep-alive. Safe to call when none is running. */
  private stopKeepAlive(): void {
    if (!this.keepAliveTimer) return;
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
  }

  /**
   * True when the active run's server URL resolves to localhost
   * (127.0.0.1 / ::1 / localhost). Tool step-into requires this — the
   * VS Code Node debugger attaches to a local inspector socket, and we
   * can't reach a remote `--inspect` port. The extension uses this to
   * surface a clean "feature unavailable" error instead of attempting
   * the attach and failing opaquely.
   */
  isLocalServer(): boolean {
    // Delegates so there is ONE loopback allowlist. The two used to be
    // separate and had already diverged on `[::1]` — which is the form
    // `new URL(...).hostname` actually returns for an IPv6 loopback, so this
    // method was quietly disabling tool step-into for those URLs.
    return this.currentServerUrl !== null && isLoopbackUrl(this.currentServerUrl);
  }

  /**
   * Acknowledge a `tool:awaiting-debugger` pause point — the extension
   * calls this after `vscode.debug.startDebugging` has actually attached
   * VS Code's Node debugger to the server process. The server then
   * proceeds past its cooperative `debugger;` statement, which the
   * inspector traps so the user lands inside the tool's TypeScript.
   *
   * 409 / not-found means we missed the parking window (e.g. the run
   * was aborted between event and ack). Silent — the SSE stream will
   * carry the actual state on the next event.
   */
  async ackToolDebugger(): Promise<void> {
    const client = this.currentClient;
    const sessionId = this.currentSessionId;
    if (!client || !sessionId) return;
    if (typeof client.ackToolDebugger !== 'function') return;
    try {
      await client.ackToolDebugger(sessionId);
    } catch (err) {
      const isNotFound =
        err !== null &&
        typeof err === 'object' &&
        'kind' in err &&
        (err as { kind?: string }).kind === 'not-found';
      if (isNotFound) return;
      const reason = err instanceof Error ? err.message : String(err);
      vscode.window.setStatusBarMessage(
        `TestBench: tool-debugger ack failed (${reason})`,
        2500,
      );
    }
  }

  stop(): void {
    this.pauseRequested = false;
    this.cancelPrompt();
    // A Stop ends the parked run, so the pause marker goes with it. It used to
    // be cleared only at the START of the next `runLines`, which left a
    // Stopped-at-a-breakpoint session flagged `parkedAtPause` forever — and
    // `skill-run-targets.ts` filters those out of the session picker, so the
    // most natural setup for that whole feature (park inside a skill, Stop,
    // then drive that browser from the skill file) was the one state the
    // picker could not see. A missing row is indistinguishable there from a
    // test that never calls the skill.
    this.parkedAtPause = false;
    // Also the disposal path: the registry tears controllers down by calling
    // stop() (see RunControllerRegistry.setApiClientFactory / dispose), so
    // this is where a paused run's keep-alive timer must be released.
    this.stopKeepAlive();
    // A stopped run is over, so there is no logical run whose compile mode is
    // worth remembering. Inheritance is already gated on `isResume` — and a
    // Stop clears the resume marker, so nothing can legitimately resume into
    // this value — but leaving a spent `'run'` parked here means any future
    // caller that gets the flag wrong inherits a compile the author never
    // asked for, which costs model calls and (in `'run'` mode) rewrites the
    // test's whole recording. Cheaper to make the field honest.
    //
    // Deliberately NOT done in `pause()`: that parks the run for a Resume,
    // which SHOULD inherit.
    this.compileModeOfRun = undefined;
    // Same argument, same exception: a stopped run has no Continue, so the
    // narrowing it parked is spent. Leaving it would narrow the next run that
    // called itself a resume.
    this.parkedNarrowing = null;
    // A Stop while the loop is PARKED has no run to abort — the parked run
    // returned long ago — so nothing else here reaches the row it left
    // `running`. It is the one row with no result and no explanation, and the
    // Stop is what settles it: ■, with the hover the ■ always carries. The
    // rows after it keep their `not run (paused)`, which is still what
    // happened to them.
    if (this.active === null && this.parkedRowState !== null) {
      this.parkedRowState = null;
      this.finalizeRowTables({ kind: 'stopped' });
    }
    this.active?.abort();
  }

  /**
   * A `step:fail` as a row failure, remembering which FILE the step is in.
   *
   * A step event's `frame.uri` is an fsPath naming the file the step lives in
   * — the test document for an inline step, a skill `.md` for a skill-body
   * one. Everything that turns a failure into words (`mainFlowOrdinal`,
   * `sectionBodyOrdinal`, `stepTextAt`) reads the TEST document at
   * `failure.line`, so a skill-body failure without this described a step of
   * the test the row may never have run. Same URI check `sectionPauseAt`
   * makes, for the same reason: an fsPath, not a `file://` URI.
   */
  private rowFailureOf(event: { line: number; error: string; frame?: FrameInfo }): RowFailure {
    const uri = event.frame?.uri;
    const elsewhere = uri !== undefined && uri !== this.document.uri.fsPath;
    return {
      line: event.line,
      error: event.error,
      ...(elsewhere && { sourceUri: uri }),
    };
  }

  /** Post a run event to the webview AND notify any registered per-run
   *  event listener. Used by every code path that emits step:start /
   *  step:pass / step:fail / output / capture / done. */
  private emitRunEvent(event: RunEvent): void {
    // A body step this run did not select, executing anyway: the server is
    // older than `runSteps` and dropped the field, so it ran the whole body.
    // Detected from the outside because that is the only place it shows —
    // a server that ignores a field it does not know says nothing about it,
    // and the run otherwise reads as green. Nothing is painted differently:
    // the step really did run, and pretending otherwise would be a second
    // untruth on top of the server's.
    //
    // The evidence has to be a step that EXECUTED, which is why a skipped pass
    // is exempt (stories/control-flow.md): a step the run decided against —
    // the untaken half of a chain, a loop body never entered — arrives as a
    // `step:pass` carrying `output: 'skipped'`, and a skipped placeholder is
    // not evidence of execution whatever line it names.
    //
    // A current server cannot produce one for an UNSELECTED body line: it
    // never expands that line, and every skipped-pass producer in
    // session-manager.ts is indexed by expansion position, so there is no
    // event to carry the line at all. This is defensive insurance rather than
    // a case seen in the wild — the rule "a skip proves nothing ran" is worth
    // holding on its own, and it costs one condition.
    // `step:start` and `step:fail` stay triggers: neither has a skipped form.
    if (
      !this.oldServerBodyStepsWarned &&
      this.unselectedBodyLines.size > 0 &&
      (event.type === 'step:start' ||
        (event.type === 'step:pass' && !isSkippedPass(event)) ||
        event.type === 'step:fail')
    ) {
      // The line is a TEST-file line, so a step of the same number in a skill
      // must not answer for it — the same fsPath check `sectionPauseAt` and
      // `startSectionIteration` make.
      //
      // A MISSING `frame.uri` is read as the test file, which is safe because
      // of two invariants rather than by luck. An event with no frame is a
      // top-level step of the test, and a top-level step's line is never a
      // body line — the map is keyed by body lines of a `### Section`, which
      // classify as `section-step` and can only run inside a section frame or
      // as a DETACHED body run. And a detached body run narrows nothing:
      // `narrowSectionSteps` returns early unless the scope is `main-flow`,
      // leaving the map empty, so there is nothing here for a frameless event
      // to collide with.
      const uri = event.frame?.uri;
      const section =
        uri === undefined || uri === this.document.uri.fsPath
          ? this.unselectedBodyLines.get(event.line)
          : undefined;
      if (section !== undefined) {
        this.oldServerBodyStepsWarned = true;
        this.postOutput(oldServerBodyStepsWarning(section), 'warn');
      }
    }
    // A failure the author told the run to carry on past is not a row failure, a
    // frame failure or a parked failure (stories/step-failure-outcomes.md, decision
    // 6). Asked once, here, because the three collectors below all key on the same
    // event and would otherwise turn an amber step into a red row, a red `[skill:]`
    // line, or a "re-run from the failed step" offer for a step already past.
    const failure = event.type === 'step:fail' && !event.tolerated ? event : null;
    // Which rows failed on which line, gathered as the run goes so the gutter
    // can be repainted with the WORST status once the loop ends. Read off the
    // events rather than threaded through the loop because a step can fail in
    // several places (a block, a batch auto-fail, an error payload) and one
    // collection point cannot miss one of them.
    if (this.currentRowNumber !== null && failure) {
      const at = this.rowFailuresByLine.get(failure.line);
      if (at) {
        if (!at.includes(this.currentRowNumber)) at.push(this.currentRowNumber);
      } else {
        this.rowFailuresByLine.set(failure.line, [this.currentRowNumber]);
      }
    }
    // The run row's own ✗ hover names the step it died at, so the row and the
    // step point at each other (decision 9). Also recorded while a Continue
    // finishes a row a pause parked in, which is the run that decides whether
    // that row ends up ✓ or ✗ — `currentRowNumber` is null there, because the
    // continuation is not itself a loop.
    if (
      failure &&
      (this.currentRowNumber !== null || this.parkedRowState?.row != null)
    ) {
      this.lastFailureThisRow ??= this.rowFailureOf(failure);
    }
    // The same question, one level down: which section ITERATION died, and at
    // which body step. Attributed by walking the frame's ancestry, because
    // the failing step can be several frames below the iteration's own —
    // a skill called from a looped body still fails that iteration.
    if (failure && failure.frame) {
      let cur: string | null = failure.frame.id;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        if (this.sectionIterationFrames.has(cur) && !this.frameFailures.has(cur)) {
          this.frameFailures.set(cur, this.rowFailureOf(failure));
        }
        cur = this.frameParents.get(cur) ?? null;
      }
    }
    this.post({ type: 'runEvent', event });
    this.currentEventListener?.(event);
  }

  /**
   * A compile log line, to the panel's Output section as well as the channel
   * (stories/compile-tail-progress.md §The panel log).
   *
   * The channel keeps its copy — it remains the full-history surface — but the
   * panel is where the author is looking, and until now the only compile line
   * it ever saw was the final result.
   */
  private logCompileLine(line: string, log: (line: string) => void): void {
    log(line);
    this.post({ type: 'compileEvent', line });
  }

  /**
   * The run's steps are done and the compile is still working: raise the
   * strip, the toast and the status bar item.
   *
   * Idempotent, and deliberately so — a split run calls it once per block, and
   * the two triggers below can both fire for one tail:
   *
   * - a `compile:progress` frame marked `runEnded`, which is the server
   *   saying the last step has ended;
   * - the first `compile:step` frame on a server that has sent no progress at
   *   all, which is all an OLDER one gives us. That trigger can land while
   *   steps are still running, so on that path the strip appears at the first
   *   generation rather than at run end. It is the degraded form on purpose:
   *   an old server puts nothing on the wire at run end, so there is nothing
   *   better to wait for.
   */
  private beginCompileTail(tail?: CompileTail): void {
    if (this.compileStrip === null) {
      this.compileStrip = tail ?? {
        file: path.basename(this.document.uri.fsPath),
        done: null,
        total: null,
        phase: 'generate',
      };
      this.post({ type: 'compileProgress', state: this.compileStrip });
      this.tailSignals?.begin(this.document.uri, this.compileStrip);
      return;
    }
    if (tail) this.updateCompileTail(tail);
  }

  /** New counts for a tail already up. */
  private updateCompileTail(tail: CompileTail): void {
    this.compileStrip = tail;
    this.post({ type: 'compileProgress', state: tail });
    this.tailSignals?.update(this.document.uri, tail);
  }

  /**
   * The tail is over. Called on `compile:result` and again when the run ends,
   * because a stream that dies without a result — a dropped connection, a
   * server that never sends one — must not leave a spinner up forever.
   */
  private endCompileTail(): void {
    if (this.compileStrip === null) return;
    this.compileStrip = null;
    this.post({ type: 'compileProgress', state: null });
    this.tailSignals?.end(this.document.uri);
  }

  /** The strip state a `compile:progress` frame describes. */
  private tailFrom(event: CompileProgressEvent): CompileTail {
    return {
      file: this.compileStrip?.file ?? path.basename(this.document.uri.fsPath),
      done: event.done,
      total: event.total,
      phase: event.phase,
      ...(event.step !== undefined && { step: event.step }),
      ...(event.line !== undefined && { line: event.line }),
      ...(event.reviewPending !== undefined && { reviewPending: event.reviewPending }),
    };
  }

  /**
   * Halt the run mid-flight without abandoning it. Aborts the current
   * stream (same mechanism as stop) but flips a flag so the abort handler
   * publishes a `breakpointStop` at the line that was executing, leaving
   * the runner in `paused` state. The user can then Resume to pick up
   * from there. No-op if no run is in flight.
   */
  pause(): void {
    if (!this.active) return;
    this.pauseRequested = true;
    this.cancelPrompt();
    this.active.abort();
  }

  resolvePrompt(text: string): void {
    const p = this.pendingPrompt;
    this.pendingPrompt = null;
    if (p) p.resolve(text);
  }

  cancelPrompt(): void {
    const p = this.pendingPrompt;
    this.pendingPrompt = null;
    if (p) p.resolve(null);
  }

  /**
   * Tell the server to drop this session and close its browser.
   */
  /**
   * Resolve an ApiClient for this controller's test from its env file, or null
   * when the env can't be resolved (no env file, missing SERVER_URL/API_KEY).
   * `sessionId` is the current/most-recent run's session id (`activeSessionId`)
   * — the stable file path for interactive runs, or the unique `<path>::run-N`
   * for batch runs — so `closeSession`, the re-run liveness probe, and getLastRun
   * all target the session the run actually used. Falls back to the file path
   * before the first run.
   *
   * `serverUrl` and `source` say which server this is and where the URL came
   * from, for callers that log their target before using it (Compile) or map
   * a transport failure onto the TBxxx catalogue. `envPath` is the .env the
   * URL was read from, or null when it is the last run's.
   */
  private async resolveClient(): Promise<ResolvedClient | null> {
    const filePath = this.document.uri.fsPath;
    const sessionId = this.activeSessionId ?? filePath;

    // Prefer the server the most-recent run actually targeted, so close /
    // liveness / getLastRun follow a run whose selected env (`.env.<name>`)
    // overrode SERVER_URL. These persist past run end (unlike currentServerUrl).
    if (this.lastRunServerUrl && this.lastRunApiKey) {
      const client = this.clientFactory({
        serverUrl: this.lastRunServerUrl,
        apiKey: this.lastRunApiKey,
      });
      return {
        client,
        sessionId,
        serverUrl: this.lastRunServerUrl,
        source: 'the last run in this window',
        envPath: this.lastResolvedEnvPath,
      };
    }

    // No run yet this session (or after a window reload): resolve base `.env`
    // from disk. Normally there's no live session to target in that state. The
    // caveat is a window reload that orphaned a session on an env-overridden
    // SERVER_URL — a fresh controller has no `lastRunServerUrl`, so this close
    // would hit the base server and miss it. Accepted: that session is keyed on
    // the file path and gets reclaimed by the next run's first-close.
    const settings = vscode.workspace.getConfiguration('testbench-native');
    const fallbackSetting = settings.get<string>('defaultEnvFile') ?? '';
    const envResolution = await resolveEnvFile({
      testFile: filePath,
      workspaceRoot: this.workspaceFolder.uri.fsPath,
      fallbackPath: fallbackSetting,
    });
    if (!envResolution.hit) return null;
    let env: Record<string, string>;
    try {
      env = await readEnvFile(envResolution.path);
    } catch {
      return null;
    }
    const serverUrl = env['SERVER_URL']?.trim();
    // Same chain as the run path (stories/machine-key.md): the project's .env,
    // the extension host's environment, then the machine key. Without the last
    // two, Compile would refuse on a machine where Run works.
    const apiKey =
      env['AIUI_SERVER_API_KEY']?.trim() ||
      process.env['AIUI_SERVER_API_KEY']?.trim() ||
      readMachineKey() ||
      '';
    if (!serverUrl || !apiKey) return null;
    return {
      client: this.clientFactory({ serverUrl, apiKey }),
      sessionId,
      serverUrl,
      source: `SERVER_URL in ${envResolution.path}`,
      envPath: envResolution.path,
    };
  }

  /**
   * Liveness gate for the re-run, called by the command handler BEFORE it
   * tears down any state (notifyRunning / resetFrameState) — so refusing a
   * dead session leaves the parked failure and its Variables panel intact.
   * Returns true when the probe is unavailable (assume live) and false only on
   * a definitive "gone" or a connection failure, so a dead session never gets
   * a partial re-run that would spin up a blank browser.
   */
  async isRerunSessionLive(): Promise<boolean> {
    const resolved = await this.resolveClient();
    if (!resolved || !resolved.client.isSessionAlive) return true;
    try {
      return await resolved.client.isSessionAlive(resolved.sessionId);
    } catch {
      return false;
    }
  }

  /**
   * Record that a session now exists on the server, and — the FIRST time it is
   * called for that session — which viewport spec the `config` block that
   * created it named (`undefined` ⇒ none).
   *
   * The two fields are written together on purpose: `configSentForSession`
   * decides whether a request may carry `config` at all, and
   * `viewportSentForSession` is only interpretable while that flag is true.
   *
   * Why only the first call writes the viewport: `config` is write-once, so
   * every request after the first in a session OMITS the block — its
   * `sessionConfig.viewport` is what the file says now, not what the live
   * browser was launched at. Re-recording it would quietly claim a relaunch
   * that never happened, which is exactly how a stale session escapes the
   * recycle gate: edit the viewport, Continue past a breakpoint (no recycle,
   * by design), and a later fresh Run would compare "tablet" against "tablet"
   * and reuse a session still rendering at 390px.
   */
  private markConfigSent(viewport: string | undefined): void {
    if (!this.configSentForSession) this.viewportSentForSession = viewport ?? null;
    this.configSentForSession = true;
  }

  /** The inverse: no session of ours is live, so the next request both may and
   *  must carry `config`, and there is no sent viewport to compare against. */
  private forgetSentConfig(): void {
    this.configSentForSession = false;
    this.viewportSentForSession = null;
  }

  /**
   * Close the live server session so the run that is starting creates a fresh
   * one at the file's new viewport (stories/per-test-viewport.md §5).
   *
   * Deliberately NOT `closeSession()`, even though the work overlaps: that
   * method is the Close Session COMMAND's path and opens with
   * `this.active?.abort()`, which is right when the user asks to tear down a
   * run in flight and wrong here. This runs at the top of a NEW run — the
   * `isRunning` guard has already established none is in flight, and the
   * `finally` of the previous run nulled `this.active`, so an abort here could
   * only ever fire at the wrong target.
   *
   * The rest is shared with the command: drop the server session, forget the
   * config we sent it, and withdraw the parked skill-step re-run affordance —
   * its page is about to be gone. Best-effort throughout: an unreachable
   * server is not a reason to refuse the run, which will report the failure
   * itself moments later with a proper TBxxx code.
   */
  private async recycleSessionForViewportChange(): Promise<void> {
    const out = getOutputChannel();
    const ts = () => new Date().toISOString().slice(11, 23);
    try {
      const resolved = await this.resolveClient();
      if (!resolved) {
        // No client resolvable (no .env / no key). Nothing of ours can be live
        // on a server we cannot address, so treat the session as gone: the
        // upcoming request will carry `config` again.
        this.forgetSentConfig();
        return;
      }
      out.appendLine(`[${ts()}] recycling server session ${resolved.sessionId} (viewport changed)`);
      await resolved.client.closeSession(resolved.sessionId);
      this.forgetSentConfig();
      this.clearSkillFailure();
      out.appendLine(`[${ts()}] session closed — the next request starts a fresh browser`);
    } catch {
      // A failed close leaves the server session in an unknown state, but the
      // client's belief has to move regardless: re-sending `config` to a
      // session that survived is refused loudly (an error the user can act on),
      // whereas omitting it silently runs at the old size — the exact failure
      // this whole path exists to prevent.
      this.forgetSentConfig();
    }
  }

  /**
   * Start a planned run row in a fresh browser
   * (stories/data-row-progress-and-selection.md §Running rows).
   *
   * Called for EVERY planned row, `rowIndex` 0 included, which is the whole
   * point: the close used to happen only at the boundary BETWEEN rows, so the
   * first row of any row run — row 1 of a Run All, the single row of Run This
   * Row, the first of a subset — reused whatever interactive session was
   * already open. It therefore started on the page the previous run left, with
   * that browser's localStorage: *Run This Row* on row 4 of
   * `securebank-matrix.md` after a full run navigated fine and then failed
   * "Reject non-essential cookies in the cookie banner", because the cookie
   * choice row 5 made was remembered and the banner never appeared.
   *
   * Order matters and is the same at every row: the session goes before the
   * row's batch so that batch creates it afresh, and `forgetSentConfig` goes
   * with it — `includeConfig` is `!configSentForSession`, which is otherwise
   * reset only in the run's `finally`, so without it the next session would
   * launch with no baseUrl, viewport or timeout and step 1 would fail.
   *
   * Two rows are exempt, both for the same reason — there is nothing of ours
   * to close:
   *
   *  - `freshBrowserPerRow` false, i.e. a selection of *some* steps: those run
   *    where the session is, once per row (decision 4), and closing the browser
   *    would put every row on a blank page rather than the one the author is
   *    standing on.
   *  - row 0 of a BATCH run: a batch mints its own `<path>::run-N` session and
   *    always launches fresh, so the close would be a no-op against a session
   *    that does not exist yet. Its later rows still recycle, exactly as before.
   *
   * The status clear stays a BOUNDARY job. At row 0 the run has already
   * cleared the file and posted the row matrix over it; clearing again here
   * would wipe the marks that seed the unselected rows.
   */
  private async recycleSessionForRow(args: {
    client: ApiClientLike;
    sessionId: string;
    rowIndex: number;
    freshBrowserPerRow: boolean;
    batchMode: boolean;
  }): Promise<void> {
    if (!args.freshBrowserPerRow) return;
    if (args.rowIndex === 0 && args.batchMode) return;
    try {
      await args.client.closeSession(args.sessionId);
    } catch {
      /* best effort — a stale session must not fail the row that follows */
    }
    this.forgetSentConfig();
    if (args.rowIndex > 0 && this.clearStatusesForUris) {
      this.clearStatusesForUris([this.document.uri]);
    }
  }

  async closeSession(): Promise<void> {
    const out = getOutputChannel();
    const ts = () => new Date().toISOString().slice(11, 23);
    const resolved = await this.resolveClient();
    if (!resolved) return;
    out.appendLine(`[${ts()}] closing server session for ${resolved.sessionId}`);
    this.active?.abort();
    await resolved.client.closeSession(resolved.sessionId);
    this.forgetSentConfig();
    // The session (and its live page) is gone — a parked skill-step re-run
    // can no longer reuse it, so withdraw the affordance.
    this.clearSkillFailure();
    out.appendLine(`[${ts()}] session closed`);
  }

  /**
   * After a STOP, poll `GET /sessions/:id/last-run` until the run is finalized,
   * then record its report path + token totals — the data the dropped `done`
   * event would have carried (issue 021). Report generation writes HTML + copies
   * screenshots AFTER the server sees our disconnect, so the path isn't ready on
   * the first poll; we poll until `finalized` with a ~12s safety ceiling sized to
   * a heavy report (not a blind short timeout). Tolerant of an older server
   * (`getLastRun` → null) and transport errors (give up, keep the prior report).
   * `generation` guards against a newer run having started meanwhile.
   */
  private async pollForLastRunAfterStop(
    client: ApiClientLike,
    sessionId: string,
    generation: number,
  ): Promise<void> {
    if (typeof client.getLastRun !== 'function') return;
    // Exponential-ish backoff; sums to ~11.5s across the sleeps.
    const delays = [50, 100, 200, 400, 800, 1200, 1600, 2000, 2400, 2800];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      let info: LastRunInfoLike | null;
      try {
        info = await client.getLastRun(sessionId);
      } catch {
        return; // transport / unauthorized — keep the previous report
      }
      if (info === null) return; // older server without the route
      if (info.finalized) {
        // Don't clobber a newer run's already-recorded report.
        if (this.runGeneration === generation) {
          if (info.reportPath) this.lastResolvedReportPath = info.reportPath;
          if (info.tokens) this.lastRunTokensValue = info.tokens;
        }
        return;
      }
      if (attempt < delays.length) await this.pollSleep(delays[attempt]!);
    }
  }

  /**
   * Run lines, and — when the request carried `compile` — attach what the
   * run's trailing compile proposed.
   *
   * A thin wrapper because `runLinesInner` has half a dozen return points and
   * a `finally`, and threading the proposal through every one of them is how
   * a path gets missed. Reset before the run, so a plain Run after a Run &
   * Compile can never hand back yesterday's proposal.
   */
  async runLines(...args: Parameters<RunController['runLinesInner']>): Promise<RunOutcome> {
    // The token, not a reset, is what makes this safe. A second call that the
    // `isRunning` guard turns away must neither wipe the in-flight run's
    // proposal (it used to, resetting before the guard) nor claim it as its
    // own. Only a call that actually STARTED a run bumps the token, and only
    // such a call reads the field.
    const tokenBefore = this.compileToken;
    const outcome = await this.runLinesInner(...args);
    if (this.compileToken === tokenBefore) return outcome;
    return this.compileResult === undefined ? outcome : { ...outcome, compile: this.compileResult };
  }

  private async runLinesInner(
    lines: number[],
    options: {
      breakpoints?: Set<number>;
      skipBreakpointAtStart?: boolean;
      /** Batch / Test Explorer mode. Interactive `[input: ...]` and
       *  `[interactive]` steps cannot prompt the user in a batch, so we
       *  short-circuit them as step:fail events. */
      batchMode?: boolean;
      /** Force a fresh session before this run. Batch mode uses this for
       *  per-test isolation; single-file flow leaves it false so sessions
       *  are reused within a TestBench session. */
      forceFreshSession?: boolean;
      /** Env name to send to the server (selects `data/<name>.json` etc).
       *  When omitted, falls back to `EnvSelector.activeEnv()`. */
      envOverride?: string | null;
      /** Hook for batch runners to observe every RunEvent emitted during
       *  this call (step:start, step:pass, step:fail, output, capture,
       *  done). Receives events in flight order. */
      onEvent?: (event: RunEvent) => void;
      /** Initial step-mode for the run. `into` / `over` / `out` start
       *  the run paused between steps so the user can drive Step Into /
       *  Over / Out from a freshly-launched stepping session. `continue`
       *  (default) runs to the next breakpoint or end-of-batch. */
      stepMode?: StepMode;
      /** Phase 5 — start the run with the one-shot pauseAtNextTool flag
       *  set. The server emits `tool:awaiting-debugger` before the next
       *  `[tool: ...]` step and parks for the debugger-attach ack. Used
       *  when F11 is hit on a tool line from a breakpoint pause (the
       *  run isn't in flight yet — we have to seed the flag in the
       *  initial steps request). */
      pauseAtNextTool?: boolean;
      /** Code-behind sibling (stories/codebehind-debugging.md): seed the
       *  one-shot pauseAtNextCodeBehind flag so the server pauses into the
       *  first step's code-behind entry, if it has one. Used when F11 is
       *  hit on a plain (non-tool, non-skill) line from a breakpoint
       *  pause. */
      pauseAtNextCodeBehind?: boolean;
      /** True when this call is a continuation of a breakpoint-paused run
       *  (i.e. Continue / Resume). Skips the status-clear that a fresh run
       *  performs so that pass marks from the first batch are preserved. The
       *  skill-file URIs revealed in the first batch are carried forward so
       *  the NEXT fresh re-run still cleans them up correctly. */
      isContinuation?: boolean;
      /**
       * True ONLY when this call resumes the SAME logical run — Continue /
       * Resume / a step command re-opening a breakpoint-paused run. Distinct
       * from `isContinuation`, which several INJECTED runs also set (the
       * Variables-panel skill re-run, the Stop-debug slice, the skill-file
       * session picker) purely for its status-preserving side: those are new
       * logical runs, and riding them into the paused run's compile would
       * silently inherit `compileModeOfRun` (a model spend the caller never
       * sees, plus — in `'run'` mode — a wholesale recording write that
       * replaces the test's recording with a one-step one) and stamp
       * `compileContinues` on the first block (re-opening a RETAINED compiler
       * from a previously COMPLETED compile instead of superseding it).
       * Compile inheritance and the first block's `compileContinues` key on
       * THIS flag alone.
       */
      isResume?: boolean;
      /**
       * Suppress the server-side breakpoint map for this run. The skill-file
       * single-step flows send it: a one-step slice pausing at its own
       * breakpoint runs (and, with compile, proposes) nothing.
       */
      suppressServerBreakpoints?: boolean;
      /** "Re-run a skill step with its variables" (see
       *  `rerunSkillStepFromFailure`). When set, the single step in `lines` is
       *  the failed `[skill: …]` invocation; the server re-expands it, starts
       *  at `startAt` (the failed body step), and seeds `seedScope` into the
       *  run. Triggers a server liveness pre-flight and forces the per-step
       *  cache off for this run. */
      rerun?: {
        startAt: { uri: string; line: number };
        /** Upper bound for a bounded re-run ("run selected skill steps on a
         *  stopped session"). Omit to run startAt → end of the skill body. */
        endAt?: { uri: string; line: number };
        /** Captured/runtime vars to inject (the merged edit path). Omitted by
         *  the Stop-debug path, which reads vars from the live session. */
        seedScope?: Record<string, string>;
      };
      /**
       * Compile the steps this run executes, as it executes them
       * (stories/compile-as-you-go.md). `'run'` is Run & Compile — Review at
       * the end, code-behind execution on; `'steps'` is Compile This Step —
       * code-behind execution off, no Review. The proposal comes back on
       * `RunOutcome.compile`; nothing is written until the caller opens the
       * diff and the author applies it.
       *
       * The mode does NOT say how much is compiled: in a data-driven file
       * every row runs and only the first one's batches carry this, because
       * one entry serves every row (rows story, decision 11). So a `'run'`
       * compile of a three-row test is the whole test compiled once, not three
       * times — and the rows that follow carry `withinCompileRun: <this mode>`
       * instead, which asks for no compile and keeps the two things the server
       * decides per batch from the mode: the AI switch's carve-out, and
       * whether code-behind executes. Which is why the mode travels: `'steps'`
       * means execution off for EVERY row of the run, not just the one that
       * compiles — otherwise rows 2..N run the broken entry row 1 is repairing.
       */
      compile?: 'run' | 'steps';
      /**
       * The `### Section` the compiled steps were authored in, when they came
       * from a body. Their ENTRIES bind under it; they still execute detached
       * at the root frame, exactly as Run Step Here runs them.
       */
      compileScope?: { section: string };
      /**
       * Run only these rows of the table under `## Steps`, by 1-based TABLE
       * position (stories/data-row-progress-and-selection.md §Running rows).
       *
       * The plan is filtered, never renumbered: `dataRow.row` stays the table
       * position and `dataRow.count` stays the table's row count, so a one-row
       * run's report reads `Row 4 of 5` and lines up with the full matrix
       * (decision 1). Omitted means every row, which is what a whole-file run
       * has always done.
       */
      rows?: number[];
      /**
       * Narrow a `### Section`'s own loop, keyed by the section name as
       * authored. Handed to `buildSectionsPayload`, which ships the chosen
       * rows plus the `rowNumbers`/`rowCount` pair that keeps the server's
       * iteration numbering on the author's table.
       */
      sectionRows?: Record<string, number[]>;
    } = {},
  ): Promise<RunOutcome> {
    if (this.isRunning) {
      return { ok: false };
    }
    // Past the guard: this call owns the compile slot for the run it is about
    // to start. Reset here rather than in the wrapper, so a call the guard
    // turned away cannot wipe the proposal of the run that turned it away.
    this.compileToken += 1;
    this.compileResult = undefined;
    this.sawCompileProgress = false;
    // A tail left up by a previous run — a stream that dropped before its
    // result — belongs to nothing now. The new run raises its own.
    this.endCompileTail();

    // Clear any stale pause indicator IMMEDIATELY — synchronously, before
    // we do any async env-file work. If we waited until after env resolution
    // (~50-200ms on Windows), the user would see the yellow ▶ from the
    // previous pause linger at that line while the new run boots, which
    // reads as "the arrow jumped straight to the breakpoint."
    this.post({ type: 'breakpointStop', line: null });
    /** Was a Continue owed when this call started? Read BEFORE the flag is
     *  cleared, because a run injected at a pause — the skill-step picker's
     *  `runLines([callLine], { isContinuation: true })` — leaves the paused
     *  run parked and its Continue still to come, and by the time the
     *  narrowing is decided below there is no way left to tell. */
    const injectedAtPause = this.parkedAtPause && options.isResume !== true;
    this.parkedAtPause = false;

    // A new run — including a Resume — supersedes any paused state, so the
    // keep-alive that was pinning the server through the pause is done.
    this.stopKeepAlive();

    // Snapshot the previous run's skill-file URIs BEFORE resetFrameState
    // wipes them — we want to clear those files' statuses too. Without
    // this, a re-run after a successful run leaves the old skill-body
    // ✓/✗ marks on the skill file, masking which steps actually ran
    // this time (and making a failure-short-circuit scenario look like
    // "test continued past the failure").
    const previousTouchedSkillUris = [...this.revealedFrameUris];

    // What the table's rows show right now — read BEFORE the fresh-run clear
    // below wipes the file. A run that narrows an axis seeds the rows it did
    // not select from this, which is what makes an unselected row untouched
    // rather than blanked (decision 6).
    const rowSeed = {
      statuses: this.lineStatuses?.() ?? new Map<number, string>(),
      hovers: this.lineHovers?.() ?? new Map<number, string>(),
    };

    // Record continuation intent BEFORE resetFrameState so the descent-clear
    // (gated by shouldClearDescentStatuses) can suppress itself on a
    // Continue/Resume, which must preserve pre-pause marks.
    this.currentRunIsContinuation = options.isContinuation === true;

    // Wipe any frame state from a previous run so the Call Stack view starts
    // empty. Pause/resume mid-skill is a Phase 3 concern; in Phase 2 the
    // stack is always empty at the entry to a run.
    this.resetFrameState();

    if (options.isContinuation) {
      // Carry the first-batch skill-file URIs forward into the new run's
      // tracking set. This preserves their pass marks (we don't clear them)
      // AND ensures the NEXT fresh re-run still knows to clean them up.
      for (const uri of previousTouchedSkillUris) {
        this.revealedFrameUris.add(uri);
      }
    } else {
      // Fresh run (not a continuation / partial re-run): a full run from the
      // top supersedes any parked skill-debug context owned by this test.
      this.onFreshRunStart?.();
      if (this.clearStatusesForUris) {
        // Clear test-file statuses AND every skill file the previous run
        // descended into. The new run will repaint as it goes; anything
        // that doesn't run this time stays blank, which matches user intent
        // ("re-run = fresh slate") and prevents stale ✓s from making a
        // short-circuited run look like it continued.
        const uris: vscode.Uri[] = [this.document.uri];
        for (const fsPath of previousTouchedSkillUris) {
          uris.push(vscode.Uri.file(fsPath));
        }
        this.clearStatusesForUris(uris);
      }
    }

    // First run on this controller? Close any session the server may still
    // be holding from a previous VS Code session — see staleSessionCleared
    // doc comment for full reasoning. Best-effort: a missing .env, a
    // server outage, or no existing session all just no-op here, and the
    // run that follows surfaces the real error if there is one.
    //
    // The pre-close clears a STALE session for a STABLE session id — only the
    // interactive (reused-session) flow has one. Batch runs use a unique per-run
    // session id (`<path>::run-N`), so there's no collision to clear, and
    // clearing here would wrongly close the interactive session for this file.
    // So skip it entirely for batch; the batch's post-run close (in the test
    // controller) tears its unique session down instead.
    const forceFresh = options.forceFreshSession === true;
    if (!options.batchMode && (forceFresh || !this.staleSessionCleared)) {
      this.staleSessionCleared = true;
      try {
        await this.closeSession();
      } catch {
        // Swallow — cleanup must not block the run.
      }
    }

    // Hook the per-run event listener (batch runner uses this to drive
    // TestRun pass/fail). Cleared in finally so it never leaks across runs.
    this.currentEventListener = options.onEvent ?? null;

    const breakpoints = options.breakpoints ?? new Set<number>();
    const skipFirstBreakpoint = options.skipBreakpointAtStart === true;

    const out = getOutputChannel();
    const log = (line: string) => out.appendLine(`[${timestamp()}] ${line}`);

    const filePath = this.document.uri.fsPath;
    log(`run requested for ${filePath}: lines=[${lines.join(',')}]`);

    const settings = vscode.workspace.getConfiguration('testbench-native');
    const fallbackSetting = settings.get<string>('defaultEnvFile') ?? '';

    const envResolution = await resolveEnvFile({
      testFile: filePath,
      workspaceRoot: this.workspaceFolder.uri.fsPath,
      fallbackPath: fallbackSetting,
    });

    if (!envResolution.hit) {
      log(`.env not found. Searched: ${envResolution.searchedDirs.join(' → ')}; fallback: "${envResolution.fallbackPath || 'unset'}"`);
      const payload = reportError('TB001', {
        searchedDirs: envResolution.searchedDirs,
        fallbackSetting: fallbackSetting,
      });
      this.lastResolvedEnvPath = null;
      return this.fail(payload, log);
    }

    log(`.env resolved (${envResolution.source}): ${envResolution.path}`);
    this.lastResolvedEnvPath = envResolution.path;

    let env: Record<string, string>;
    try {
      env = await readEnvFile(envResolution.path);
    } catch (err) {
      if (err instanceof EnvParseError) {
        const payload = reportError('TB005', {
          envPath: envResolution.path,
          lineNumber: err.lineNumber,
          line: err.line,
        });
        log(`TB005 ${payload.diagnosis}`);
        return this.fail(payload, log);
      }
      throw err;
    }

    // Which environment this run targets. An explicit override (batch mode
    // passes one per test) wins over the workspace-level EnvSelector. The SAME
    // value feeds both the client-side $VAR overlay below and the `envName`
    // sent to the server, so ## Parameters / ## Config resolve against the same
    // env the server uses for ${env.X}.
    //
    // Trim + treat blank as unset: EnvSelector.activeEnv() already normalises,
    // but the batch `envOverride` carries frontmatter `env:` verbatim — a quoted
    // `env: " t2 "` would otherwise form `.env. t2 ` and spuriously TB006.
    const effectiveEnvName =
      ((options.envOverride !== undefined ? options.envOverride : EnvSelector.activeEnv()) ?? '')
        .trim() || null;

    // Overlay the selected `.env.<name>` on top of base `.env` so $VAR
    // references in ## Parameters / ## Config — and SERVER_URL/AIUI_SERVER_API_KEY —
    // honour the active environment (matching the server's ${env.X} map and the
    // CLI). A selected env with no matching file is a hard error (TB006); a
    // malformed overlay reuses TB005 with the overlay's path.
    if (effectiveEnvName) {
      // Read the overlay from the workspace root — where the env selector
      // enumerates `.env.*` and where the CLI/server read `.env.<name>`
      // (projectRoot). A walked-up / test-adjacent base `.env`'s directory
      // would instead let a selector-offered env resolve to a missing file
      // and spuriously TB006.
      const envDir = this.workspaceFolder.uri.fsPath;
      const overlayPath = path.join(envDir, `.env.${effectiveEnvName}`);
      let overlay: Record<string, string> | null;
      try {
        overlay = await readEnvOverlayFile(envDir, effectiveEnvName);
      } catch (err) {
        if (err instanceof EnvParseError) {
          const payload = reportError('TB005', {
            envPath: overlayPath,
            lineNumber: err.lineNumber,
            line: err.line,
          });
          log(`TB005 ${payload.diagnosis}`);
          return this.fail(payload, log);
        }
        throw err;
      }
      if (overlay === null) {
        const payload = reportError('TB006', {
          envName: effectiveEnvName,
          expectedPath: overlayPath,
          baseEnvPath: envResolution.path,
        });
        log(`TB006 ${payload.diagnosis}`);
        return this.fail(payload, log);
      }
      env = composeEnv(env, overlay);
      // The KEYS, not just how many: this line is the only place a run says
      // which values the overlay took over, and the ones that mislead hardest
      // when they are silently replaced (AI_API_KEY, SERVER_URL) look exactly
      // like a broken bridge or a dead server from every other error message.
      // Safe to name — a key is not its value, and the values are secrets.
      const keys = Object.keys(overlay);
      log(
        keys.length === 0
          ? `.env.${effectiveEnvName} overlaid (no keys)`
          : `.env.${effectiveEnvName} overlaid (${keys.length} ` +
              `${keys.length === 1 ? 'key' : 'keys'}: ${keys.join(', ')})`,
      );
    }

    if (!env['SERVER_URL'] || env['SERVER_URL'].trim() === '') {
      const payload = reportError('TB002', { envPath: envResolution.path });
      return this.fail(payload, log);
    }
    const serverUrl = env['SERVER_URL'].trim();
    try {
      new URL(serverUrl);
    } catch {
      const payload = reportError('TB004', { envPath: envResolution.path, value: serverUrl });
      return this.fail(payload, log);
    }
    // The client chain of stories/machine-key.md: the project's walk-up .env,
    // then the extension host's environment, then the machine key. Most
    // machines only ever have the last one — `aiui serve` generates it.
    const projectKey = env['AIUI_SERVER_API_KEY']?.trim();
    const processKey = process.env['AIUI_SERVER_API_KEY']?.trim();
    const apiKey = projectKey || processKey || readMachineKey() || '';
    if (apiKey === '') {
      const payload = reportError('TB003', {
        envPath: envResolution.path,
        machineEnvPath: userRootEnvPath(),
      });
      return this.fail(payload, log);
    }

    const text = this.document.getText();

    // Refuse a file whose sections the CLI would reject, before building any
    // request. The wire format cannot represent a duplicate name — a JSON
    // object collapses them — so without this the CLI would error on a file
    // TestBench ran anyway, silently picking a different definition.
    const sectionProblem = preflightSections(text);
    if (sectionProblem) {
      const payload = reportError('TB024', { detail: sectionProblem });
      return this.fail(payload, log);
    }

    // An `Else if` / `Otherwise` that follows no decision, refused before
    // anything runs (stories/control-flow.md §"Runs that start or end
    // mid-structure"), in the CLI parser's own wording. The commonest cause is
    // an `[input:]` between two members: that step splits the batch, so the
    // chain's halves land in different requests — the first deciding and
    // dispatching nothing, the second arriving with no decision to act on —
    // and neither half can be right on its own. Client-side because the split
    // is the client's: the server only ever sees the pieces.
    const chainProblem = danglingChainMemberError(text);
    if (chainProblem) {
      const payload = reportError('TB032', { detail: chainProblem });
      return this.fail(payload, log);
    }

    // What the caller's line selection means. `scope` is the new half: a
    // selection made entirely of section-body lines resolves to those lines
    // and runs them DETACHED, at the root frame (see
    // stories/specs/sections-run-and-resume.md §4.2). A selection naming any
    // main-flow step resolves to the main flow only, body lines dropped —
    // which keeps a drag that spans a call and its body from running the body
    // twice.
    const selection = resolveRunSelection(text, lines);
    const effectiveLines = selection.lines;

    // An empty resolution means the selection named no step of EITHER kind
    // and no main-flow step sits below it (a heading, prose, a blank past the
    // end). That is indistinguishable downstream from the "no lines
    // requested" convention, which means run everything — so without this
    // guard "run from my cursor" would silently run the WHOLE test against
    // the live session.
    //
    // Every user gesture funnels through here — the webview run message,
    // runSelected, runStepHere, Continue and both re-run flows — which is why
    // the guard lives at this choke point rather than in commands/index.ts.
    // Legitimate flows can't trip it: batch mode passes `[]`, and
    // continuations and re-runs pass explicit step lines.
    if (lines.length > 0 && effectiveLines.length === 0) {
      const payload = reportError('TB025', {});
      return this.fail(payload, log);
    }

    const allClassified = classifySelectedSteps(text, effectiveLines, selection.scope);
    if (allClassified.length === 0) {
      const payload = reportError('TB021', {});
      return this.fail(payload, log);
    }

    // Trim the run at the first breakpoint we encounter (skipping the very
    // first item when resuming). The pause line is reported back via the
    // `breakpointStop` message so the gutter shows the yellow ▶ arrow.
    const { runnable: classified, pausedAt } = trimAtBreakpoint(
      allClassified,
      breakpoints,
      skipFirstBreakpoint,
    );

    // A pause inside a DETACHED body run parks on a body line, so it needs a
    // resume context or Continue would read it as a stale marker and refuse.
    // `callLine: null` says "detached" — nothing invoked this body, so the
    // resume re-runs the rest of it the same way, with no anchor.
    const detachedBodyContext =
      selection.scope === 'section-body'
        ? ({ kind: 'section-body', callLine: null } as const)
        : undefined;

    // Stale pause was already cleared at the top of runLines. The *new*
    // pause indicator (if any) is posted only when execution actually
    // reaches the pause point — putting the yellow ▶ on the breakpoint
    // line before the steps before it have run reads as "we're already
    // there" instead of "we will pause here."
    if (pausedAt !== null) {
      log(`⏸ Will pause before breakpoint on line ${pausedAt} — Resume to continue`);
    }

    if (classified.length === 0) {
      // Hit a breakpoint on the first selected step — nothing to send to
      // the server. We *are* immediately at the pause point, so post the
      // indicator now and treat it as a successful "paused at start"
      // outcome.
      if (pausedAt !== null) {
        this.parkedAtPause = true;
        this.post({
          type: 'breakpointStop',
          line: pausedAt,
          ...(detachedBodyContext && { resumeContext: detachedBodyContext }),
        });
        // This branch leaves the UI paused just like the two in-loop pause
        // sites, so it needs the same pin — and it is the one that most
        // needs it, since a run that sends nothing generates no traffic at
        // all. The session being kept alive belongs to a PREVIOUS run
        // (`this.currentClient` isn't built yet), so hand one in explicitly.
        this.startKeepAlive({
          client: this.clientFactory({ serverUrl, apiKey }),
          sessionId: filePath,
        });
      }
      this.emitRunEvent({ type: 'done', status: 'aborted' });
      return { ok: true };
    }

    const rawConfig = parseConfig(text);
    const rawParameters = parseParameters(text);
    const resolvedParameters = resolveSection(rawParameters, env);
    const sessionConfig: { baseUrl?: string; timeout?: string; viewport?: string } = {};
    const baseUrl = rawConfig['baseUrl'];
    if (baseUrl) sessionConfig.baseUrl = resolveValue(baseUrl, env);
    const timeout = rawConfig['timeout'];
    if (timeout) sessionConfig.timeout = resolveValue(timeout, env);
    // Forwarded raw, exactly like baseUrl: the server resolves the preset and
    // owns the one validator + error message (stories/per-test-viewport.md §3).
    // `resolveValue` still runs so `viewport: $VIEWPORT` works off the .env
    // overlay — that is client-side $VAR resolution, not viewport parsing.
    const viewport = rawConfig['viewport'];
    if (viewport) sessionConfig.viewport = resolveValue(viewport, env);

    const logging = resolveLoggingOverride(rawConfig, settings);

    if (Object.keys(resolvedParameters).length > 0) {
      this.post({ type: 'parametersResolved', values: { ...resolvedParameters } });
    }

    log(
      `running ${classified.length} item(s) on ${serverUrl}` +
        (sessionConfig.baseUrl ? ` baseUrl=${sessionConfig.baseUrl}` : '') +
        (sessionConfig.viewport ? ` viewport=${sessionConfig.viewport}` : '') +
        (Object.keys(resolvedParameters).length > 0
          ? ` parameters=[${Object.keys(resolvedParameters).join(',')}]`
          : ''),
    );

    // Recycle-on-change (stories/per-test-viewport.md §5). Per-session `config`
    // is write-once on the wire: a session created at 390×844 keeps that size
    // for its whole life, and a batch that re-sent `config` would be refused.
    // So the only way an edited `viewport:` can take effect is for the CLIENT
    // to close the session and let this run create a fresh one — otherwise the
    // browser silently keeps the old size while the file, the log and the
    // report all say the new one, which defeats the feature outright.
    //
    // Restricted to a FRESH start of an interactive run:
    //  - a continuation (Continue after a breakpoint) and a parked skill-step
    //    re-run both resume against the live page. Closing it would throw away
    //    the very state the user paused to inspect, and the viewport can only
    //    have "changed" because they edited the file while parked.
    //  - a batch run mints its own `<path>::run-N` session and tears it down
    //    afterwards, so it always launches fresh; there is nothing to recycle.
    //
    // `baseUrl` / `timeout` edits keep their current (non-recycling) behaviour
    // — §5 scopes the restart to viewport on purpose.
    const freshInteractiveStart =
      options.batchMode !== true &&
      options.isContinuation !== true &&
      options.rerun === undefined;
    const viewportChange = decideViewportRecycle({
      // `configSentForSession` is the client's own record that a session of
      // ours exists on the server (it is set the moment a stream yields).
      sessionLive: freshInteractiveStart && this.configSentForSession,
      sentViewport: this.viewportSentForSession,
      requestedViewport: sessionConfig.viewport,
    });
    if (viewportChange.recycle) {
      log(viewportChange.logLine);
      await this.recycleSessionForViewportChange();
    }

    // The AbortController is created BEFORE the server-readiness phase so the
    // Stop button cancels a wedged health wait or spawn poll. An abort during
    // that phase is an `aborted` run, not an auto-start error (§5).
    const ac = new AbortController();
    this.active = ac;

    const serverReady = await this.ensureServerReady({ serverUrl, signal: ac.signal, log });
    if (serverReady.kind !== 'proceed') {
      // Same per-run cleanup the main body's `finally` does. This return
      // happens before that try block, so the state it sets up — notably the
      // event listener — would otherwise outlive the run.
      this.active = null;
      this.currentEventListener = null;
      this.currentRunIsContinuation = false;
      this.pauseRequested = false;
      this.cancelPrompt();
      if (serverReady.kind === 'aborted') {
        this.emitRunEvent({ type: 'done', status: 'aborted' });
        log('run aborted by user while waiting for the server');
        return { ok: true };
      }
      this.emitRunEvent({ type: 'done', status: 'error' });
      return this.fail(serverReady.payload, log);
    }

    // Server is up and the probe's inspector answer is fresh — let the
    // injected hook attach a debugger BEFORE any step (or code-behind module
    // load) can execute, so `.steps.ts` breakpoints bind in time. Awaited on
    // purpose: an attach that raced the first batch would miss the module
    // load. The hook owns its failures.
    if (this.server.onServerReady) {
      // Swallowed on purpose, and the hook's own contract says so: "failures
      // are the hook's to swallow — a run must never break because an attach
      // did." It was unguarded, and this `await` sits OUTSIDE the run's
      // try/finally, so a rejection escaped `runLines` without ever emitting
      // `done` — leaving `active` and the event listener set and the gutter
      // stuck on "running" with no way back except reloading the window.
      try {
        await this.server.onServerReady({ inspectorUrl: this.currentInspectorUrl, serverUrl, log });
      } catch (err) {
        log(
          `debugger auto-attach failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const client = this.clientFactory({ serverUrl, apiKey });
    // Monotonic run id — a background post-stop report poll (issue 021) uses it
    // to avoid clobbering a newer run's report path if one starts meanwhile.
    const myGeneration = ++this.runGeneration;
    // Batch runs get a UNIQUE per-run session id so two runs of the same file
    // are two distinct server sessions (Case 2). Interactive runs reuse the
    // stable file-path id so re-runs reuse the same session. The server names
    // reports from the separately-sent testFilePath, so the `::run-N` suffix
    // never leaks into report/log names. Stored in `activeSessionId` (not
    // cleared at run end) so the batch post-run close targets this exact session.
    const sessionId =
      options.batchMode === true ? `${filePath}::run-${myGeneration}` : filePath;
    this.activeSessionId = sessionId;
    this.pauseRequested = false;
    this.lastStepStartLine = null;
    // Capture so step-control commands (Phase 3) can target the same
    // session via the same client without rebuilding either.
    this.currentClient = client;
    this.currentSessionId = sessionId;
    this.currentServerUrl = serverUrl;
    // Persist the run's server target past run end so out-of-band lifecycle
    // ops (close / liveness / getLastRun via resolveClient) follow this run even
    // after currentServerUrl is nulled — needed once .env.<name> can retarget
    // SERVER_URL away from base .env.
    this.lastRunServerUrl = serverUrl;
    this.lastRunApiKey = apiKey;

    // `effectiveEnvName` (resolved above, alongside the env overlay) is the env
    // sent to the server below so its ${env.X} map matches the client overlay.
    const params: Record<string, string> = { ...resolvedParameters };

    /**
     * The rows of a data-driven run (stories/data-driven-rows.md, part A),
     * read once when Run is pressed.
     *
     * Snapshotted here rather than re-read per block, because `runStepBlock`
     * re-reads the live buffer for `fullSteps` and `sections`: without the
     * snapshot an edit to the table mid-run could change the count, reorder
     * the rows, or make the row numbers in the report lie.
     *
     * A partial run — a re-run from a step, a Continue after a pause, a
     * selection of lines — never loops. Those are all continuations of a run
     * whose rows have already been decided, and re-entering the loop would
     * start it again from row 1.
     */
    /**
     * A Continue is not a new selection. It rebuilds `lines` as "every
     * main-flow step at or below the pause" — no body lines, no row lines — so
     * recomputing either narrowing from it would answer "nothing was
     * narrowed" and run the whole body. The run that parked already decided
     * this; the continuation inherits it, as it inherits the compile mode.
     */
    const resumingNarrowing = options.isResume === true ? this.parkedNarrowing : null;
    // Cleared unless a Continue is still owed. A run INJECTED at a pause — the
    // skill-step picker's `runLines([callLine], { isContinuation: true })`,
    // which is followed by a `isParkedAtPause` check precisely because the
    // paused run is still there — is not a resume and carries no `isResume`,
    // but the Continue after it is. Dropping the park here would run the rest
    // of the narrowed body on that Continue, paint the marks the selection
    // excluded, and disarm the old-server detector on the way past.
    if (!injectedAtPause) this.parkedNarrowing = null;
    /**
     * The section-loop narrowings that survive this run's step selection.
     *
     * A narrowing whose call line is not among the steps about to execute has
     * nothing to narrow — the section will not be entered — so it is dropped
     * and said out loud. Logged rather than refused, because an axis nobody
     * selected means all of it, and a drag that stopped a line short of the
     * call has already said which steps it wants ("Open for review").
     */
    // A Continue inherits the ROW narrowing for the reason it inherits the
    // body one: its `lines` are rebuilt from the pause point and hold no row
    // lines, so re-deriving would answer "nothing was narrowed" and loop the
    // whole table for the rest of the run.
    const sectionRowsForRun = resumingNarrowing
      ? resumingNarrowing.rows
      : this.narrowSectionRows(options.sectionRows, allClassified);
    this.sectionRowsOfRun = sectionRowsForRun;
    if (resumingNarrowing) {
      this.sectionRowTotalsOfRun = resumingNarrowing.rowTotals;
      // Said again, beside the body line and for the same reason: a narrowing
      // announced before the breakpoint and silent after it reads as one that
      // expired there.
      for (const [name, rows] of Object.entries(resumingNarrowing.rows ?? {})) {
        this.postOutput(
          sectionRowsResumedLogLine(
            name,
            rows,
            resumingNarrowing.rowTotals?.[name] ?? rows.length,
          ),
          'info',
        );
      }
    }
    /**
     * …and the same question about a section's BODY.
     *
     * Answered here, at the one choke point every gesture reaches, rather than
     * in `runSelected`: F5, the panel's Run and a `runRows` carrying `lines`
     * all arrive with the body lines still in `lines`, and a narrowing done in
     * one of them would be missing from the other two. `resolveRunSelection`
     * has already dropped those lines from what EXECUTES — rung 2's
     * double-run guard, which stays exactly as it was — and this reads them
     * before they are forgotten, to narrow the body the call expands to.
     *
     * `allClassified`, not `classified`: a breakpoint trims what runs in this
     * BATCH, and the call it trimmed off still runs on Continue. Narrowing off
     * the trimmed list made a breakpoint above the call report the narrowing
     * as ignored, and then the continuation ran the whole body.
     */
    if (resumingNarrowing) {
      this.sectionStepsOfRun = resumingNarrowing.steps;
      this.unselectedBodyLines = resumingNarrowing.unselectedBodyLines;
      this.narrowedBodySnapshot = resumingNarrowing.bodySnapshot;
      // Said again on the continuation, because the Output is a log of what
      // this call did and the author is reading it after a pause — and a
      // narrowing that was announced before the breakpoint and silent after it
      // reads as one that expired there.
      for (const [name, indices] of Object.entries(resumingNarrowing.steps ?? {})) {
        const snapshot = this.narrowedBodySnapshot?.[name];
        this.postOutput(
          sectionStepsResumedLogLine(
            name,
            indices.map((n) => n + 1),
            snapshot?.steps.length ?? indices.length,
            snapshot?.everyCall ?? false,
          ),
          'info',
        );
      }
    } else {
      this.sectionStepsOfRun = this.narrowSectionSteps(
        lines,
        selection.scope,
        allClassified,
      );
    }
    // The "your server is too old to number these rows" warning is a fact
    // about this run's server, said once (`rowForIteration`).
    this.oldServerNumberingWarned = false;
    this.oldServerBodyStepsWarned = false;
    // …and so is a stale narrowing, which is a fact about the FILE: it refuses
    // identically for every block and every row after the first, so it is said
    // once and it ends the run.
    this.narrowingRefusal = null;

    const wholeFileRun =
      options.rerun === undefined &&
      options.isContinuation !== true &&
      options.isResume !== true;
    /**
     * The matrix a pause parked, when THIS call is the Continue of that run.
     *
     * A pause ends the loop after the current row, and that row is left
     * `running` because it is not finished. This call is what finishes it, so
     * it keeps the matrix alive (the `else` below would otherwise empty it)
     * and closes the row out in the `finally` — pass, fail, or still parked if
     * it hits the next breakpoint.
     *
     * Anything that is not a resume abandons the park: a fresh run rebuilds
     * the matrix from scratch, and there is nothing left to go back to.
     */
    const resumingParked = options.isResume === true ? this.parkedRowState : null;
    if (resumingParked === null) this.parkedRowState = null;
    const allRows = wholeFileRun ? this.readDataRows(text, filePath, log) : null;
    // A malformed SECTION table used to be silent everywhere: `readDataRows`
    // reports the run table's parse error, `buildSectionsPayload` swallows the
    // section scan's, and the decoration pass swallows it again — so the
    // section simply ran once with `{{file}}` unresolved and the author had no
    // line to look at. Said here, in the same place and the same voice as the
    // run table's.
    if (wholeFileRun) this.reportSectionTableErrors(text, filePath, log);
    /**
     * The rows this run will actually execute, each keeping its TABLE number.
     *
     * `options.rows` filters; it never renumbers. `row` is the position the
     * author sees in the file and `count` is the whole table's, so the
     * report's `Row 4 of 5`, the panel's numbering and the gutter's mark all
     * name the same row whether the run was the whole table or one line of it
     * (decision 1).
     */
    /** The narrowing, or undefined for "every row". An EMPTY list is not a
     *  narrowing: an axis with nothing selected means all of that axis
     *  (decision 3), and the panel never sends one for exactly that reason. */
    const narrowRows =
      options.rows !== undefined && options.rows.length > 0 ? options.rows : undefined;
    const dataRows = ((): Array<{ row: number; values: Record<string, string> }> | null => {
      if (allRows === null) return null;
      const planned = allRows
        .map((values, index) => ({ row: index + 1, values }))
        .filter((r) => narrowRows === undefined || narrowRows.includes(r.row));
      // Nothing matched — every number was out of range, which the pre-flight
      // refusal catches before we get here. Falling back to "no loop" rather
      // than an empty plan matters anyway: an empty plan would run no steps at
      // all and report the test green.
      return planned.length > 0 ? planned : null;
    })();
    /** The table's row count — the `of M`, which a subset does not shrink. */
    const rowCount = allRows?.length ?? 0;
    /**
     * Does the row boundary restart the browser?
     *
     * A fresh browser per row belongs to the whole-file run; a selection of
     * steps runs where the session is, once per row, which is what Run
     * Selected Steps has always meant (decision 4). The loop itself is gated
     * by `wholeFileRun` as before — this narrows what the boundary DOES, not
     * whether it happens.
     *
     * "Whole file" is a fact about coverage, not about how the run was
     * started: Ctrl+A then F5, or shift-clicking the first step and the last
     * in the panel, both arrive here with a non-empty `lines` naming every
     * step there is. Reading that as a step selection put five rows in one
     * browser and started rows 2..5 on the dashboard row 1 signed into — a
     * selection that covers everything means everything, which is what it
     * already means for steps.
     *
     * Decided from the RESOLVED steps, not from the raw lines. The two are not
     * the same question, and the gesture that separates them is the most
     * natural one there is: drag from `## Steps` down to step 1 and the raw
     * lines are a heading, a table and a blank — no step among them — while
     * `resolveRunSelection`'s fallback ("every main-flow step at or below the
     * lowest selected line") correctly resolves it to the whole flow. Asking
     * the raw set whether it covers every step answered no, and five rows ran
     * in one browser: rows 2..5 started on the dashboard row 1 signed into,
     * with no cookie banner left to reject.
     */
    const freshBrowserPerRow =
      lines.length === 0 ||
      (selection.scope === 'main-flow' &&
        effectiveLines.length === extractSteps(text).length);
    // The live matrix behind the row marks and the panel's Rows section.
    //
    // Built for a whole-file run only, and emptied otherwise. A partial run —
    // a re-run from a step, a Continue, a selection — is a continuation of a
    // run whose rows were already decided and already painted, and posting an
    // all-`pending` matrix into it would wipe those marks. Running a CHOSEN
    // subset of rows is the next wave; it seeds the matrix from what the rows
    // already are rather than from `pending`.
    if (wholeFileRun) {
      this.buildRowTables(
        text,
        filePath,
        {
          ...(narrowRows && { rows: narrowRows }),
          ...(sectionRowsForRun && { sectionRows: sectionRowsForRun }),
        },
        rowSeed,
      );
      this.postRows();
    } else if (resumingParked === null) {
      this.rowTables = [];
      // …and say so. A file that HAD a table and no longer has one (the table
      // was deleted, then Run) would otherwise leave the panel showing rows
      // that are not in the file any more: `postRows` used to return early on
      // an empty list, so the last thing the panel ever heard was the old
      // matrix.
      this.postRows();
    }
    /** One entry per iteration: the row and its table number, or a single
     *  `null` for an ordinary run. */
    const rowPlan: Array<{ row: number; values: Record<string, string> } | null> =
      dataRows ?? [null];
    // A step selection in a data-driven file runs those steps once PER ROW,
    // which is right (decision 3, an unselected axis means all of it) and was
    // also the one thing nothing on screen said: F5 on one highlighted step
    // repainted it five times and the only clue was five `Row N of 5` banners.
    // Said once, before the first batch, on every path that gets here — the
    // editor's F5, the panel's Run, the palette.
    if (dataRows !== null && lines.length > 0 && narrowRows === undefined && !freshBrowserPerRow) {
      this.postOutput(
        stepsPerRowLogLine(
          classified.filter((c) => c.kind === 'step').length,
          dataRows.length,
        ),
        'info',
      );
    }
    /** Per-row outcome, for the end-of-run summary. */
    const rowOutcomes: Array<{ row: number; values: Record<string, string>; failed: boolean }> = [];
    /**
     * Rows whose batch was sent, whether or not it finished.
     *
     * Not the same as `rowOutcomes`, which only gains a row that ran to the
     * end of its steps. A row interrupted by Stop still reaches the server,
     * which accumulates its results under an `aborted` status — so reporting
     * it as "not run" would give it two lines in the matrix, one from the
     * accumulator and one from the client.
     */
    const attemptedRows = new Set<number>();
    /**
     * Which compile mode this logical run is in.
     *
     * A Continue after a breakpoint is a separate `runLines` call with its own
     * options, and the author who pressed Run & Compile did not stop wanting a
     * compile when they hit a breakpoint — so a continuation inherits the mode
     * of the run it is continuing. Without this the rest of the test ran as a
     * plain Run and its entries were never generated.
     */
    const compileMode =
      options.compile ?? (options.isResume === true ? this.compileModeOfRun : undefined);
    // Recorded for every run that is not a RESUME — a resume continues the
    // mode it inherited, and everything else (a fresh run, and an injected
    // one) is its own logical run and owns the field. Keying this on
    // `isContinuation` left an injected compile's `'steps'` unrecorded, so the
    // stale `'run'` from the last fresh run survived and the NEXT resume
    // inherited it — the silent inheritance `isResume` exists to stop, one
    // site short.
    if (options.isResume !== true) this.compileModeOfRun = options.compile;
    // Which row the recording will be of. Every row runs, but only the first
    // one's actions are recorded (rows story, decision 11) — so an entry that
    // references a column the first selected row leaves empty is a surprise
    // unless the log says whose values it recorded. "First SELECTED": with a
    // narrowed run that is the first row of the selection, not of the table.
    //
    // Said as a fact, and now true: the compile fields ride the first planned
    // row's batches only (`rowCompile` below). They used to ride every row's,
    // and every shape of row loop paid for it, by its own route:
    //
    //  - **whole-file run** (`freshBrowserPerRow`) — `recycleSessionForRow`
    //    closes the session before each row, the server discards the retained
    //    compiler with it, and each row opened a fresh full compile of the
    //    same entries: three rows, three generations per step, three
    //    proposals, and the recording on disk was the LAST row's while this
    //    line said row 1.
    //  - **a step selection** (Compile This Step in a table file; the session
    //    is kept) — the server clears `session.liveCompile` after every
    //    `'steps'` compile, so each row opened a fresh one there too.
    //  - **a kept-session `'run'` compile** — one compiler across the rows,
    //    which is worse in a quieter way: the same steps accumulate into it N
    //    times, so the recording it writes holds every row's actions. The
    //    server can be driven this way and tests/api-server-rows-compile.test.ts
    //    covers it; THIS client cannot get there. `runAndCompile` passes no
    //    lines for a `'run'` compile, so `freshBrowserPerRow` is always true
    //    and the session is always recycled — the first bullet is the shape a
    //    `'run'` compile of a table file actually took.
    if (compileMode && dataRows !== null && dataRows.length > 0) {
      this.postOutput(`compile records row ${dataRows[0]!.row}`, 'info');
    }
    /** Step-blocks already sent in THIS call — the second onwards continues
     *  the compiler the first opened. Counts every row's blocks, which costs
     *  nothing: only row 0 sends compile fields, and its blocks are the first
     *  ones counted. */
    let compileBlocksSent = 0;
    let anyFailed = false;
    const batchMode = options.batchMode === true;

    // `rerun` belongs to the FIRST block only. Its `startAt` names a line
    // inside the expansion of the steps that block sends; a later block —
    // which exists whenever an `[input:]` or `[interactive]` step splits the
    // run — expands to something that no longer contains it, and the server
    // would refuse with "Re-run anchor not found". Invisible before section
    // resumes, because every earlier re-run flow sent exactly one step.
    let pendingRerun = options.rerun;

    /**
     * Why the row loop stopped early, when it did — the four exits that are
     * not "the last row finished".
     *
     * `paused` is the one that used to be missing entirely. `parkedAtPause` is
     * assigned AFTER the loop (a breakpoint trim) or in the catch (a Pause),
     * so the `if (this.parkedAtPause) break` at the top of each iteration
     * never fired for a breakpoint: `trimAtBreakpoint` handed the loop steps
     * 1..3, and the loop ran those three steps five times and painted every
     * row ✓ — a green `5 rows · 5 passed` with the pause arrow sitting on step
     * 4. The decision to end the loop has to be taken where the row's block
     * ends, not two exits later.
     */
    let loopEnd: RowSkipReason | null = null;

    try {
      for (const [rowIndex, planned] of rowPlan.entries()) {
      const row = planned?.values ?? null;
      const rowNumber = planned?.row ?? 0;
      /**
       * The compile mode THIS row's batches carry — the first planned row's,
       * and nothing else (rows story, decision 11).
       *
       * An entry is keyed by (file, section, authored step text, occurrence),
       * so one entry serves every row: row 2 has nothing new to generate, and
       * asking for it costs a model call per step per row.
       *
       * Worse than the cost, and differently per shape. Where the loop
       * restarts the browser (`freshBrowserPerRow`, a whole-file run) the
       * session is closed between rows and the server discards the retained
       * compiler with it, so each row proposed its own whole-file diff; a
       * `'steps'` compile of a selection keeps the session but the server
       * clears `session.liveCompile` after every `'steps'` compile, so it
       * came out the same way — and those two are the shapes this client
       * sends. A kept-session `'run'` compile would continue ONE compiler and
       * accumulate the same steps into it once per row, leaving a recording N
       * rows deep: the server can be driven that way
       * (tests/api-server-rows-compile.test.ts covers it), TestBench cannot.
       * `runAndCompile` passes no lines for a `'run'` compile, so
       * `freshBrowserPerRow` is always true and the session is always
       * recycled.
       *
       * `rowIndex === 0` and not `planned !== null`: an ordinary run has the
       * single-`null` plan and is row 0, so it keeps compiling exactly as
       * before. Within row 0 the run may still be SPLIT — an `[input:]` or
       * `[interactive]` step, or a breakpoint — and those later blocks carry
       * `compileContinues` as they always did, from `compileBlocksSent`. A
       * resume is never a row loop (`wholeFileRun` is false, so `dataRows` is
       * null) and so is always row 0.
       */
      const rowCompile = rowIndex === 0 ? compileMode : undefined;
      if (planned !== null && row !== null) {
        // A pause ends the loop after the current row (decision 6), and it is
        // decided at the END of that row's block (`loopEnd`), not here:
        // `parkedAtPause` is only assigned once the loop is over, so a guard
        // reading it at the TOP of the next iteration could never fire.
        // Resuming the loop itself would need a row cursor that survives a
        // Continue; the debugging loop is Run This Row instead.
        if (rowIndex > 0 && ac.signal.aborted) break;
        // Every planned row starts in a fresh browser — the FIRST one included.
        await this.recycleSessionForRow({
          client,
          sessionId,
          rowIndex,
          freshBrowserPerRow,
          batchMode,
        });
        // Rebuilt rather than mutated: `[input:]` answers write into `params`,
        // and one row's answer must not leak into the next.
        for (const key of Object.keys(params)) delete params[key];
        Object.assign(params, resolvedParameters, row);
        this.post({ type: 'parametersResolved', values: { ...params } });
        const shown = rowValuesText(row);
        // `(steps 3–6)` when the run named steps, so the log says what ran as
        // well as which row it ran for — a partial row is not the same event
        // as a whole one and the report has to be readable against it.
        const scope = stepRangeText(
          classified
            .filter((c) => c.kind === 'step')
            .map((c) => mainFlowOrdinal(text, c.line))
            .filter((n): n is number => n !== null),
        );
        const scopeText = freshBrowserPerRow || scope === null ? '' : ` (${scope})`;
        this.postOutput(`Row ${rowNumber} of ${rowCount}${scopeText} — ${shown}`, 'info');
        log(`row ${rowNumber}/${rowCount}`);
        this.currentRowNumber = rowNumber;
        attemptedRows.add(rowNumber);
        // After the boundary's status clear, not before: that clear wipes the
        // whole file, row marks included, and re-posting the matrix here is
        // what puts rows 1..n-1 back on the table.
        this.lastFailureThisRow = null;
        this.startRunRow(rowNumber);
      }
      const rowFailedAtStart = anyFailed;
      let i = 0;
      while (i < classified.length) {
        if (ac.signal.aborted) break;
        const item = classified[i]!;

        if (item.kind === 'step') {
          const block: ClassifiedStep[] = [];
          while (i < classified.length && classified[i]!.kind === 'step') {
            block.push(classified[i]!);
            i++;
          }
          const ok = await this.runStepBlock({
            block,
            client,
            sessionId,
            env,
            envName: effectiveEnvName,
            params,
            sessionConfig,
            logging,
            cacheOverride: rawConfig['cache'],
            ...(row !== null && {
              dataRow: { row: rowNumber, count: rowCount, values: row },
            }),
            signal: ac.signal,
            log,
            ...(options.stepMode && { stepMode: options.stepMode }),
            ...(options.pauseAtNextTool && { pauseAtNextTool: true }),
            ...(options.pauseAtNextCodeBehind && { pauseAtNextCodeBehind: true }),
            ...(pendingRerun && { rerun: pendingRerun }),
            ...(rowCompile && { compile: rowCompile }),
            // Blocks 2..n of this call, and every block of a true RESUME: the
            // compiler for this run is already open on the session. Never an
            // injected run's first block — its `isContinuation` preserves
            // marks, not the previous run's compiler, and the server must
            // supersede whatever a completed or abandoned compile left open.
            ...(rowCompile && (compileBlocksSent > 0 || options.isResume === true) && {
              compileContinues: true,
            }),
            // Travels with `compile`, never without it — it names the section
            // a Compile This Step's entries belong to, and a batch with no
            // compile has nothing to scope. (`runStepBlock` narrows it again
            // to `'steps'`; this gate is about the ROW, not the mode.)
            ...(rowCompile && options.compileScope && { compileScope: options.compileScope }),
            // The rows that do NOT compile, saying which run they belong to —
            // and, because it is the same field, which KIND of run.
            //
            // The server decides two things per batch from `compile`, and
            // dropping it from rows 2..N dropped both:
            //
            //  - the AI switch's carve-out (stories/run-settings.md §9). On a
            //    project with `ai.allowInRuns: false`, row 1 came back with a
            //    diff and every later row failed with "this run forbids AI" —
            //    and the proposal is not applied until the loop ends, so there
            //    was no compiled entry for them to run either. One gesture,
            //    half carved out.
            //  - whether code-behind EXECUTES, which only `'steps'` turns off.
            //    Compile This Step runs its step under AI so a broken entry
            //    re-records; rows 2..N ran the existing entry instead, which
            //    threw, healed under AI, and painted ⚠ on the very step whose
            //    repair was in flight. Hence the mode travels, not a `true`.
            ...(compileMode !== undefined && rowCompile === undefined && {
              withinCompileRun: compileMode,
            }),
            ...(options.suppressServerBreakpoints && { suppressServerBreakpoints: true }),
          });
          compileBlocksSent++;
          pendingRerun = undefined;
          if (!ok) {
            anyFailed = true;
            // A stale narrowing is not this row's failure — it is a fact about
            // the file, and the next row would re-read the same buffer, refuse
            // the same way and print the same line. Without ending the LOOP,
            // a two-row table said it twice and a ten-row one said it ten
            // times, each row painted ✗, and the run never reached a verdict
            // the author could act on.
            if (this.narrowingRefusal !== null) loopEnd = { kind: 'narrowing-stale' };
            break;
          }
          continue;
        }

        if (item.kind === 'input') {
          if (batchMode) {
            // Batch mode can't show prompts. Auto-fail the test with a clear
            // pointer to the offending line so the user knows to run it from
            // the editor (F5) instead.
            log(`[batch] input on line ${item.line} → auto-fail (interactive steps not supported in batch)`);
            this.emitRunEvent({
              type: 'step:fail',
              line: item.line,
              error: `Step on line ${item.line} requires interactive input ([input: ${item.varName}]) — interactive and [input: ...] steps cannot run in batch mode. Run this test from its editor (F5) to provide a value.`,
            });
            anyFailed = true;
            break;
          }
          log(`prompt input on line ${item.line} → {{${item.varName}}}`);
          // An `[input:]` prompt is a THIRD client-side pause: the previous
          // batch has completed, so the server has no run in flight and no
          // traffic while the user types — exactly the blind spot §3's
          // keep-alive exists for, just a flavour the spec doesn't enumerate.
          // A user who walks away mid-prompt would otherwise lose the session
          // and its browser to the idle shutdown.
          const answer = await this.withKeepAlive(() =>
            this.requestPrompt({
              mode: 'input',
              message: item.prompt,
              varName: item.varName,
            }),
          );
          if (answer === null) {
            log(`input on line ${item.line} canceled — aborting run`);
            // Cancelling is how you say "not this run". In a data-driven file
            // it used to say it once per row: the break left `anyFailed`
            // false, so the row was painted ✓, the loop moved on and prompted
            // again — five prompts to cancel a five-row test, and five ✓ marks
            // for steps that never ran. It ends the loop, like a Stop, and the
            // row it happened in says what happened rather than claiming a
            // pass.
            loopEnd = { kind: 'prompt-cancelled' };
            break;
          }
          params[item.varName] = answer;
          // `maskIfSecretAuthored`, the same masker the capture banner uses,
          // because an `[input: name]` name is author-chosen end to end — it
          // is written in the test file, never derived from a page. Identical
          // in behaviour today: the two maskers differ only on a DOTTED name,
          // and `INPUT_STEP_RE` (src/parser/markdown.ts) matches `\w*`, which
          // has no dot in it. What it buys is that the rule stated here is the
          // one that is true, so the day a name can carry a dot this line
          // already agrees with the report.
          this.postOutput(
            `✎ ${item.varName} ← ${maskIfSecretAuthored(item.varName, answer)}`,
            'info',
          );
          i++;
          continue;
        }

        if (item.kind === 'interactive') {
          if (batchMode) {
            log(`[batch] interactive on line ${item.line} → auto-fail`);
            this.emitRunEvent({
              type: 'step:fail',
              line: item.line,
              error: `Step on line ${item.line} is [interactive] — interactive steps cannot run in batch mode. Run this test from its editor (F5) instead.`,
            });
            anyFailed = true;
            break;
          }
          log(`interactive on line ${item.line}: ${item.hint}`);
          // Same client-side blind spot as the `[input:]` prompt, and more
          // exposed: an [interactive] step is the pause flavour designed for
          // long human-driven exploration, so it is the likeliest of all to
          // outlive the idle window between its REPL turns.
          const exitedCleanly = await this.withKeepAlive(() =>
            this.runInteractive({
              hint: item.hint,
              client,
              sessionId,
              env,
              envName: effectiveEnvName,
              params,
              sessionConfig,
              logging,
              signal: ac.signal,
              log,
            }),
          );
          // `/quit`, a cancelled prompt, or an abort. All three mean the
          // author is finished with this run — so, as for a cancelled
          // `[input:]`, the LOOP is finished too rather than starting the next
          // row's REPL.
          if (!exitedCleanly) {
            loopEnd = { kind: 'prompt-cancelled' };
            break;
          }
          i++;
          continue;
        }
      }

      // Will this row's block leave the run PARKED at a breakpoint? The post-
      // loop code below turns `pausedAt` into the yellow ▶ under exactly these
      // conditions; asked here because that is where the loop can still act on
      // the answer, and because the row that is parked in is not a row that
      // has passed — half its steps have not run.
      const parkedHere =
        row !== null && pausedAt !== null && !anyFailed && !ac.signal.aborted;
      if (parkedHere) loopEnd = { kind: 'paused' };

      if (row !== null && !parkedHere && loopEnd === null) {
        // A failing row does not stop the loop (decision 6) — a matrix exists
        // to show *which* rows fail. The run as a whole is still failed if any
        // row was, which is what `anyFailed` carries forward.
        const rowFailed = anyFailed && !rowFailedAtStart;
        rowOutcomes.push({
          row: rowNumber,
          values: row,
          failed: rowFailed,
        });
        // The row's own mark. A row cut off by Stop leaves the loop through
        // the `break` above, never reaching here, and is closed out as
        // `stopped` by `finalizeRowTables` instead.
        if (!ac.signal.aborted) {
          this.endRunRow(rowNumber, rowFailed ? this.lastFailureThisRow : null, text);
        }
      }
      // A pause ends the loop after the current row (rows story, decision 6),
      // and so does a cancelled prompt. Both leave the row they happened in
      // `running` — where the run actually is — for `finalizeRowTables` to
      // settle, and every row after them is one the loop planned and never
      // reached.
      if (loopEnd !== null) {
        if (row !== null) {
          log(
            loopEnd.kind === 'paused'
              ? `run paused during row ${rowNumber} — remaining rows not run`
              : `run ended during row ${rowNumber} — remaining rows not run`,
          );
        }
        break;
      }
      } // end of the row loop

      this.markConfigSent(sessionConfig.viewport);

      const status: 'passed' | 'failed' | 'aborted' =
        ac.signal.aborted ? 'aborted' : anyFailed ? 'failed' : 'passed';
      // Now that all preceding steps actually finished, surface the pause
      // indicator so the yellow ▶ shows up on the paused line. Skip on
      // failure/abort — the user didn't reach the pause point, so the
      // arrow would be misleading.
      if (status === 'passed' && pausedAt !== null) {
        this.parkedAtPause = true;
        this.post({
          type: 'breakpointStop',
          line: pausedAt,
          ...(detachedBodyContext && { resumeContext: detachedBodyContext }),
        });
        // The batch is done and the session now sits with no run in flight —
        // invisible to the server's idle accounting while the user thinks.
        this.startKeepAlive();
      }
      this.emitRunEvent({ type: 'done', status });
      log(`run ${status}`);
      return { ok: !anyFailed };
    } catch (err) {
      if (isUserAbort(err)) {
        // Pause vs Stop: the user-abort path is the same (AbortController),
        // so the controller's pauseRequested flag tells us which intent.
        // On pause we publish breakpointStop so the UI shows the yellow ▶
        // and offers Resume; on stop we just mark the run aborted.
        if (this.pauseRequested) {
          // Resume point: the line that was executing when pause fired.
          //
          // Pause-inside-skill: when the active frame stack is non-empty,
          // the step that was running lives on a skill file — but Resume
          // can't continue mid-skill (the server doesn't support that
          // yet). Instead we anchor the resume on the test-file's
          // `[skill: ...]` invocation line, which `frameRoot` records on
          // every frame:push. Continue from there re-runs the whole
          // skill, which is the closest honest semantic.
          //
          // Pause-inside-SECTION is the exception, and the reason
          // `sectionPauseAt` exists: a section body lives in the test file
          // and the server can re-enter it at an exact line, so anchoring on
          // the invocation would re-run steps the user already watched pass.
          //
          // Pause-at-top-level: fall back to the line of the most recent
          // step:start. If pause fired before any step:start (e.g. the
          // user hit Pause immediately after Run), fall back to the first
          // step in the run — without this, paused state is never set and
          // the Resume button doesn't render.
          const topFrame = this._frameStack[this._frameStack.length - 1];
          const root = topFrame ? this.frameRoot.get(topFrame.id) : undefined;
          const firstStepLine = classified.find((c) => c.kind === 'step')?.line ?? null;
          const sectionPause = this.sectionPauseAt(topFrame, text);
          const resumeLine = sectionPause
            ? sectionPause.bodyLine
            : root
              ? root.testLine
              : this.lastStepStartLine ?? firstStepLine;
          if (resumeLine != null) {
            this.parkedAtPause = true;
            this.post({
              type: 'breakpointStop',
              line: resumeLine,
              ...(sectionPause && {
                resumeContext: { kind: 'section-body', callLine: sectionPause.callLine },
              }),
              ...(!sectionPause && detachedBodyContext && {
                resumeContext: detachedBodyContext,
              }),
            });
            // Same as the breakpoint case: paused is invisible to the server.
            this.startKeepAlive();
            this.emitRunEvent({ type: 'done', status: 'aborted' });
            log(`run paused at line ${resumeLine} — Resume to continue`);
            return { ok: true };
          }
        }
        this.emitRunEvent({ type: 'done', status: 'aborted' });
        log('run aborted by user');
        // On a real STOP (not a pause — note line is reachable on a pause whose
        // resumeLine resolved to null), recover the report path + token totals
        // the dropped `done` event would have carried (issue 021). Fire-and-
        // forget with the client/session captured into LOCALS now: the `finally`
        // below nulls this.currentClient/SessionId and flips isRunning false
        // immediately, so we must not await (that would keep the run "running"
        // for the whole poll). The generation guard stops a late result from
        // clobbering a newer run's report.
        if (!this.pauseRequested) {
          const c = this.currentClient;
          const sid = this.currentSessionId;
          if (c && sid && typeof c.getLastRun === 'function') {
            void this.pollForLastRunAfterStop(c, sid, myGeneration);
          }
        }
        return { ok: true };
      }
      const payload = mapApiErrorToPayload(err, { serverUrl, envPath: envResolution.path });
      this.emitRunEvent({ type: 'done', status: 'error' });
      return this.fail(payload, log);
    } finally {
      // Close out the table marks FIRST: the row that was cut off goes ■, the
      // row a pause parked keeps its band, and the rows the loop planned and
      // never reached go to the skip mark with the reason. Before
      // `pauseRequested` is reset below, since a pause, a Stop and a run that
      // died leave different hovers behind — and `parkedAtPause` is in the
      // test alongside it because a breakpoint parks the run without anyone
      // pressing Pause, and the rows after it are just as re-runnable.
      //
      // `loopEnd` outranks both: the loop itself decided to stop, at the point
      // the row's block ended, and it knows why.
      //
      // Before `finishRowRun`, not after, because that is what makes the
      // Output's per-row lines and its `Rows:` summary readable off the
      // matrix. A Stop mid-row leaves that row in neither `rowOutcomes` (it
      // never finished its steps) nor `notRun` (its batch was sent), so
      // without a finalised matrix to read, the row had no line at all and the
      // summary's parts summed to one less than the count.
      const endReason: RowSkipReason =
        loopEnd !== null
          ? loopEnd
          : this.pauseRequested || this.parkedAtPause
            ? { kind: 'paused' }
            : ac.signal.aborted
              ? { kind: 'stopped' }
              : { kind: 'ended' };
      // The Continue of a parked row is what settles that row. Before
      // `finalizeRowTables`, which would otherwise read a row still marked
      // `running` as one the run was cut off inside and paint it ■.
      //
      // Not when this Continue parked again — the run is then still inside
      // that row, one breakpoint further on — and not when it was Stopped,
      // which is the ■ case for real.
      if (
        resumingParked?.row != null &&
        !this.parkedAtPause &&
        !ac.signal.aborted
      ) {
        this.endRunRow(resumingParked.row, anyFailed ? this.lastFailureThisRow : null, text);
      }
      this.finalizeRowTables(endReason);
      // Who owns the matrix now this call is over.
      //
      // A pause leaves it PARKED — the row it stopped in keeps its band and
      // the Continue of this run is what settles it. Anything else ends the
      // park: the run finished, was stopped, or died. `currentRowNumber` is
      // still the row the loop was on (it is cleared below); a Continue that
      // parks again is not itself a loop, so it inherits the row it resumed.
      this.parkedRowState =
        endReason.kind === 'paused' && this.parkedAtPause && this.rowTables.length > 0
          ? { row: this.currentRowNumber ?? resumingParked?.row ?? null }
          : null;
      // The one report a data-driven run gets. Here rather than after the
      // loop because the loop has four exits — the last row, Stop, a pause
      // parking the run, and a thrown row — and three of them leave through a
      // `return` or a throw. A row that dies still leaves a report covering
      // the rows that ran.
      if (dataRows) {
        this.currentRowNumber = null;
        await this.finishRowRun({
          client,
          sessionId,
          rowPlan,
          rowOutcomes,
          attemptedRows,
          endReason,
          batchMode,
          log,
        });
      }
      // The narrowing belonged to this run, so all three fields are cleared
      // together — leaving any of them set would silently narrow a section the
      // NEXT run never asked to narrow, and `unselectedBodyLines` would arm
      // the old-server warning against a run with nothing to warn about.
      //
      // Parked first when this run paused: its Continue rebuilds its lines
      // from the pause point and cannot re-derive any of this, so the one
      // thing that must survive is handed over explicitly.
      //
      // An injected run at a pause parks nothing of its own and takes nothing
      // away: the paused run's Continue is still owed, and its narrowing is
      // still the one that Continue must carry.
      this.parkedNarrowing =
        endReason.kind === 'paused' && this.parkedAtPause
          ? {
              rows: this.sectionRowsOfRun,
              rowTotals: this.sectionRowTotalsOfRun,
              steps: this.sectionStepsOfRun,
              unselectedBodyLines: this.unselectedBodyLines,
              bodySnapshot: this.narrowedBodySnapshot,
            }
          : injectedAtPause
            ? this.parkedNarrowing
            : null;
      this.sectionRowsOfRun = undefined;
      this.sectionRowTotalsOfRun = undefined;
      this.sectionStepsOfRun = undefined;
      this.unselectedBodyLines = new Map();
      this.narrowedBodySnapshot = undefined;
      // A stream that ended without a `compile:result` (a dropped connection,
      // a server error) must not leave a spinner running for the rest of the
      // session. On the ordinary path the result already took it down and this
      // is a no-op.
      this.endCompileTail();
      this.active = null;
      this.pauseRequested = false;
      this.cancelPrompt();
      this.post({ type: 'promptDone' });
      this.currentEventListener = null;
      this.currentClient = null;
      this.currentSessionId = null;
      this.currentServerUrl = null;
      // NOT cleared here: `currentInspectorUrl` outlives the run body on
      // purpose. A tool step-into ack can arrive while the run is unwinding,
      // and the next run's health probe resets it as its first act.
      // Reset the persistent run id so out-of-band ops when idle (notably an
      // interactive "Close Session"/restartSession) fall back to the stable file
      // path via resolveClient, rather than a stale batch `::run-N` left over
      // from a previous batch run (which would no-op and leak the interactive
      // session — issue 032).
      this.activeSessionId = null;
      // A batch run owns a UNIQUE per-run session; close it HERE (where its id is
      // a local) so its video finalises and the browser frees before the next
      // test. Interactive runs keep their session open for reuse, so don't close.
      // Uses the local client/sessionId (this.current* are nulled above).
      // Best-effort — cleanup must never fail the run.
      if (batchMode) {
        try {
          await client.closeSession(sessionId);
        } catch {
          /* swallow — teardown must not break the run */
        }
        // The session that `config` was sent for no longer exists, and the
        // next batch run of this file gets a NEW `::run-N` id — so the block
        // must ride again, or that run's browser would launch without the
        // test's baseUrl/timeout/viewport. Safe to reset unconditionally here:
        // batch runs go through their own RunController (see
        // RunControllerRegistry.getBatchController), so this never clears the
        // flag for a live interactive session, which would re-send `config`
        // into the server's write-once refusal.
        this.forgetSentConfig();
      }
    }
  }

  // ---- narrowing a section's loop ----------------------------------------

  /**
   * Drop the section narrowings this run cannot honour, and say so.
   *
   * A section is entered only by a step that calls it, so a narrowing whose
   * call line is not among the steps about to run narrows nothing — the loop
   * will not happen. The surviving ones each announce themselves, because a
   * narrowed section changes what the steps AFTER the call see (a count that
   * was 3 is now 1) and the failure downstream has to read as a consequence
   * rather than a mystery.
   *
   * Matched on `matchText`, the same rule the server expands by, so the two
   * cannot disagree about which step calls which section — `calledSectionNames`
   * for the whole answer, tails and nested calls included, over the steps this
   * RUN selected rather than the ones this batch stops at.
   */
  private narrowSectionRows(
    requested: Record<string, number[]> | undefined,
    classified: ClassifiedStep[],
  ): Record<string, number[]> | undefined {
    if (!requested || Object.keys(requested).length === 0) return undefined;
    const text = this.document.getText();
    let tables: Map<string, { rows: unknown[] }>;
    try {
      tables = scanSectionDataTables(text, this.document.uri.fsPath) as Map<
        string,
        { rows: unknown[] }
      >;
    } catch {
      return undefined;
    }
    const called = calledSectionNames(text, instructionsOf(classified));
    const out: Record<string, number[]> = {};
    const totals: Record<string, number> = {};
    for (const [name, requestedRows] of Object.entries(requested)) {
      const table = tables.get(name);
      if (!table) continue;
      const rows = [...new Set(requestedRows)]
        .sort((a, b) => a - b)
        .filter((n) => n >= 1 && n <= table.rows.length);
      if (rows.length === 0) continue;
      if (!called.has(matchText(name))) {
        this.postOutput(sectionRowsIgnoredLogLine(name, rows), 'warn');
        continue;
      }
      out[name] = rows;
      // The denominator the resumed line needs. Kept beside the chosen rows
      // rather than re-scanned on the Continue: that scan reads the LIVE
      // buffer, and the number in `rows 2 of 3` should be the one this run
      // decided with.
      totals[name] = table.rows.length;
      this.postOutput(sectionRowsLogLine(name, rows, table.rows.length), 'info');
    }
    if (Object.keys(out).length === 0) return undefined;
    this.sectionRowTotalsOfRun = totals;
    return out;
  }

  /**
   * The section-BODY narrowings this run can honour, and the lines that let it
   * notice a server that ignored them.
   *
   * Only a MIXED selection narrows a body. A selection made of body lines
   * alone resolves to `section-body` scope and runs those lines detached, at
   * the root frame — the flow that has always existed and is not this one; and
   * a selection with no body lines at all has nothing here to do. What is left
   * is the reported gesture: some main-flow steps, one of them the call, plus
   * some of the body it expands to. `resolveRunSelection` drops the body lines
   * from what executes inline (the double-run guard), and this is what stops
   * them from being dropped from the run's MEANING as well.
   *
   * Also records the body lines the run did NOT select, per narrowed section.
   * A `step:start` on one of those is the only way the client can tell that a
   * server ignored `runSteps` and ran the whole body — the run would otherwise
   * look green and paint marks nobody asked for.
   */
  private narrowSectionSteps(
    lines: number[],
    scope: 'main-flow' | 'section-body',
    classified: ClassifiedStep[],
  ): Record<string, number[]> | undefined {
    this.unselectedBodyLines = new Map();
    this.narrowedBodySnapshot = undefined;
    if (scope !== 'main-flow' || lines.length === 0) return undefined;
    const text = this.document.getText();
    const { narrowed, ignored } = splitBodySteps(text, lines, instructionsOf(classified));
    for (const pick of ignored) {
      // The steps the author actually picked, not the ones a chain would have
      // brought along: this narrowing is being dropped, so naming a step
      // nobody selected in the sentence that drops it explains nothing.
      const picked = pick.ordinals.filter((n) => !pick.addedForChain.includes(n));
      this.postOutput(sectionStepsIgnoredLogLine(pick.section, picked), 'warn');
    }
    if (narrowed.length === 0) return undefined;
    const bodies = new Map(extractSections(text).map((s) => [s.name, s.steps]));
    const out: Record<string, number[]> = {};
    const snapshot: Record<string, { steps: string[]; everyCall: boolean }> = {};
    for (const pick of narrowed) {
      out[pick.section] = pick.indices;
      const body = bodies.get(pick.section) ?? [];
      // What the indices MEAN, frozen at run start. Every later block rebuilds
      // the payload from the live buffer, so an edit to the body mid-run would
      // silently re-point them — `readDataRows` snapshots the rows for the
      // same reason, and this is the same hazard one level down.
      snapshot[pick.section] = {
        steps: body.map((s) => s.instruction),
        everyCall: pick.everyCall,
      };
      // A chain kept whole. Said before the narrowing line, because it changes
      // what that line is about to claim.
      if (pick.addedForChain.length > 0 && pick.chainLink) {
        this.postOutput(
          chainMembersKeptLogLine(
            pick.section,
            pick.addedForChain,
            pick.ordinals.filter((n) => !pick.addedForChain.includes(n)),
            pick.chainLink,
          ),
          'warn',
        );
      }
      this.postOutput(
        sectionStepsLogLine(pick.section, pick.ordinals, pick.total, pick.everyCall),
        'info',
      );
      const kept = new Set(pick.indices);
      for (const [index, step] of body.entries()) {
        if (!kept.has(index)) this.unselectedBodyLines.set(step.line, pick.section);
      }
    }
    this.narrowedBodySnapshot = snapshot;
    return out;
  }

  /**
   * Refuse a block whose narrowing no longer describes the file, once.
   *
   * `sentence` is a whole sentence: the reasons compose badly under a shared
   * tail, so each branch of `narrowedBodyDrift` (and `SectionNarrowingError`)
   * finishes its own thought and this only frames it.
   *
   * Once, because the refusal is a fact about the FILE. Every later block of
   * this run rebuilds the payload from the same buffer and refuses the same
   * way — in a data-driven run, once per row — so the second copy of the line
   * tells the reader nothing the first did not.
   */
  private refuseStaleNarrowing(
    sentence: string,
    log: (msg: string) => void,
    logPrefix: string,
  ): void {
    log(`${logPrefix}: ${sentence}`);
    if (this.narrowingRefusal !== null) return;
    this.narrowingRefusal = sentence;
    this.postOutput(`Run stopped: ${sentence} Re-run to pick again.`, 'error');
  }

  /**
   * Has a narrowed section's body been edited since the run started?
   *
   * `runSteps` is a list of POSITIONS, and every block after the first rebuilds
   * the sections payload from the live buffer — so an edit that adds, removes
   * or rewrites a body step re-points them at whatever now sits there. The
   * server would run it without complaint, and the Output would still name the
   * steps the author picked.
   *
   * Refused rather than repaired, and named: there is no honest way to guess
   * which steps the author meant after the text moved, and the run is a few
   * seconds old.
   */
  private narrowedBodyDrift(text: string): string | null {
    if (!this.narrowedBodySnapshot) return null;
    const bodies = new Map(
      extractSections(text).map((s) => [s.name, s.steps.map((step) => step.instruction)]),
    );
    // Each branch is a WHOLE sentence. They used to be fragments finished by
    // one shared "… since this run narrowed it, so …" tail, which read as
    // written only for the third: "the body of X now has 3 steps where it had
    // 2 since this run narrowed it" says the count changed since the
    // narrowing, which is a different claim, and the deleted-section branch
    // ended up explaining that a section that is gone no longer names the same
    // steps.
    const stale = 'so the body steps it selected no longer name the same steps.';
    for (const [name, snapshot] of Object.entries(this.narrowedBodySnapshot)) {
      const before = snapshot.steps;
      const now = bodies.get(name);
      if (now === undefined) {
        return `the section "${name}" is gone from the file, and this run had narrowed its body.`;
      }
      if (now.length !== before.length) {
        return (
          `the body of "${name}" now has ${now.length} step` +
          `${now.length === 1 ? '' : 's'} where it had ${before.length} when this ` +
          `run narrowed it, ${stale}`
        );
      }
      const changed = now.findIndex((instruction, i) => instruction !== before[i]);
      if (changed >= 0) {
        return `body step ${changed + 1} of "${name}" has been edited since this run narrowed it, ${stale}`;
      }
    }
    return null;
  }

  // ---- which rows are red -------------------------------------------------

  /**
   * The rows to re-run, as `runLines` options, or null when there are none.
   *
   * Read off the GUTTER — the tracker's own marks on the row lines — rather
   * than remembered from the last run this window happened to see. That is
   * what makes the offer survive a window reload: the marks are persisted,
   * and the tracker's signature check already drops them when the table
   * changes, row line by row line, so there is nothing left for a separate
   * shape check to catch. It also means a red row is re-runnable in a window
   * that never ran it, which is how a reader who reopens yesterday's failure
   * expects a "re-run the failures" button to behave.
   */
  get failedRowsToRerun(): { rows?: number[]; sectionRows?: Record<string, number[]> } | null {
    const statuses = this.lineStatuses?.();
    if (!statuses) return null;
    return failedRowsFrom(this.document.getText(), (line) => statuses.get(line));
  }

  // ---- the row matrix ----------------------------------------------------

  /**
   * Snapshot every data table in the document into `rowTables`, all rows
   * `pending`.
   *
   * Snapshotted, like `readDataRows`, rather than re-read per boundary: an
   * edit to a table mid-run could otherwise change a row's line number and
   * send a ✓ to the wrong row.
   *
   * A malformed table contributes nothing — the run already reported the
   * parse error and goes ahead unlooped, and a matrix built from a table the
   * runner refused would describe a loop that is not happening.
   */
  private buildRowTables(
    text: string,
    filePath: string,
    /**
     * Which rows this run planned, per table — omit a table's entry and every
     * one of its rows is planned, which is the whole-file case.
     *
     * A row this run did NOT plan is seeded from what the editor already
     * shows rather than from `pending`, because `pending` is a cleared cell:
     * the row boundary wipes the file's statuses and the matrix is what puts
     * them back, so seeding an unselected row `pending` would erase the ✓ it
     * earned last time (decision 6 — untouched, never skipped).
     */
    plan?: { rows?: number[]; sectionRows?: Record<string, number[]> },
    /**
     * What the gutter showed BEFORE this run's opening status clear.
     *
     * Read at the top of `runLines`, not here: the fresh-run clear wipes the
     * whole file (row marks included) long before this is called, so reading
     * the tracker now would seed every unselected row `pending` — which is
     * exactly the erasure decision 6 forbids.
     */
    seed?: { statuses: Map<number, string>; hovers: Map<number, string> },
  ): void {
    const tables: RowTableState[] = [];
    const painted = seed?.statuses ?? new Map<number, string>();
    const hovers = seed?.hovers ?? new Map<number, string>();
    const toState = (
      scan: { headerLine: number; rowLines: number[]; rows: Array<Record<string, string>> },
      table: 'run' | { section: string },
      kind: RowTableKind,
      chosen: number[] | undefined,
    ): RowTableState => ({
      table,
      kind,
      headerLine: scan.headerLine,
      rows: scan.rows.map((values, index) => {
        const row = index + 1;
        const line = scan.rowLines[index] ?? scan.headerLine;
        const planned = chosen === undefined || chosen.includes(row);
        const carried = planned ? undefined : painted.get(line);
        const hover = planned ? undefined : hovers.get(line);
        return {
          row,
          line,
          values: rowValuesText(values),
          status: planned
            ? ('pending' as DataRowStatus)
            : rowStatusFromLineStatus(carried),
          ...(hover !== undefined && { hover }),
          planned,
        };
      }),
    });
    try {
      const run = parseDataRows(text, filePath);
      if (run) tables.push(toState(run, 'run', 'run', plan?.rows));
    } catch {
      /* reported by readDataRows; the run goes ahead unlooped */
    }
    try {
      for (const [section, scan] of scanSectionDataTables(text, filePath)) {
        tables.push(toState(scan, { section }, 'section', plan?.sectionRows?.[section]));
      }
    } catch {
      /* a half-written section table paints nothing */
    }
    this.rowTables = tables;
    this.rowStartedAt = null;
    this.sectionIterationFrames.clear();
    this.sectionIterationsSeen.clear();
    this.frameFailures.clear();
  }

  /** The run-level table, or undefined when the file has none. */
  private runTable(): RowTableState | undefined {
    return this.rowTables.find((t) => t.table === 'run');
  }

  /** A section's table by the name the author wrote on the `###` heading. */
  private sectionTable(name: string): RowTableState | undefined {
    return this.rowTables.find(
      (t) => typeof t.table === 'object' && t.table.section === name,
    );
  }

  /**
   * Post the matrix. Every boundary that changes a row's state ends here, so
   * there is exactly one place that decides what the panel and the gutter
   * see.
   *
   * An EMPTY list is a message too, not a reason to stay quiet: it is what a
   * file whose table has been deleted has to say about itself, and the panel's
   * Rows section only disappears because it was told.
   */
  private postRows(): void {
    const msg: HostRowsMsg = {
      type: 'rows',
      uri: this.document.uri.toString(),
      tables: this.rowTables.map((t) => ({
        table: t.table,
        headerLine: t.headerLine,
        rows: t.rows.map((r) => ({
          row: r.row,
          line: r.line,
          values: r.values,
          status: r.status,
          ...(r.detail !== undefined && { detail: r.detail }),
          ...(r.hover !== undefined && { hover: r.hover }),
          ...(r.durationMs !== undefined && { durationMs: r.durationMs }),
        })),
      })),
    };
    this.post(msg);
  }

  /**
   * Write one row's state, keeping the worse of the old and the new.
   *
   * The never-downgrade rule is what makes a section table honest inside a
   * data-driven run: its rows are looped once per RUN row, so the last clean
   * run row would otherwise erase a failure three rows back. `running` and
   * `pending` are the two exceptions — a row that starts again is running,
   * whatever it was last time, and that is how the band follows the loop.
   */
  private setRowState(
    table: RowTableState | undefined,
    row: number,
    patch: { status: DataRowStatus; detail?: string; hover?: string; durationMs?: number },
  ): void {
    const entry = table?.rows.find((r) => r.row === row);
    if (!entry) return;
    const next =
      patch.status === 'running' || patch.status === 'pending'
        ? patch.status
        : worseRowStatus(entry.status, patch.status);
    entry.status = next;
    if (next === 'running' || next === 'pending') {
      entry.detail = undefined;
      entry.hover = undefined;
    } else if (next === patch.status) {
      // Only the winning status describes itself: a `passed` that lost to a
      // previous run row's `failed` must not overwrite that failure's hover.
      entry.detail = patch.detail;
      entry.hover = patch.hover;
    }
    if (patch.durationMs !== undefined) entry.durationMs = patch.durationMs;
    this.recordWorst(entry, patch);
  }

  /**
   * Remember the worst TERMINAL state a row has reached, and on which run rows.
   *
   * `status` alone cannot carry this. A section table inside a data-driven run
   * is looped once per RUN row, and each iteration starts by setting the row
   * `running` — the exception in `setRowState` above, which is what makes the
   * band follow the loop and which also clears the detail and the hover. So a
   * section row that failed on run row 1 was reset to `running` on run row 2
   * and then to `passed`, and the failure and its explanation were gone: the
   * green mark after a red one that §"Across run rows" exists to forbid.
   */
  private recordWorst(entry: RowState, patch: { status: DataRowStatus; detail?: string; hover?: string }): void {
    if (patch.status === 'running' || patch.status === 'pending') return;
    const runRow = this.currentRowNumber;
    const prior = entry.worst;
    if (prior === undefined || worseRowStatus(prior.status, patch.status) !== prior.status) {
      entry.worst = {
        status: patch.status,
        ...(patch.detail !== undefined && { detail: patch.detail }),
        ...(patch.hover !== undefined && { hover: patch.hover }),
        runRows: runRow === null ? [] : [runRow],
      };
      return;
    }
    // Same verdict again, one run row later — name that row too, so the hover
    // that survives the loop says which run rows it is about.
    if (prior.status === patch.status && runRow !== null && !prior.runRows.includes(runRow)) {
      prior.runRows.push(runRow);
    }
  }

  /**
   * Paint each row's worst terminal state, once the loop that repainted it is
   * over — with the run rows it failed on named in the hover, the way a step
   * line's worst-of-rows hover says *Failed on rows 2, 4* (decision 9).
   */
  private applyWorstAcrossRunRows(table: RowTableState): void {
    for (const entry of table.rows) {
      const worst = entry.worst;
      if (worst === undefined) continue;
      // A row still `running` is where the run is parked, and its verdict is
      // not in yet — a Continue decides it. Overwriting the band with an
      // earlier run row's ✓ would hide the one thing the reader needs.
      if (entry.status === 'running') continue;
      if (worst.status === entry.status && worst.runRows.length <= 1) continue;
      entry.status = worst.status;
      entry.detail = worst.detail;
      entry.hover = withRunRowsNote(worst.hover, worst.runRows);
    }
  }

  /**
   * A run row is starting: band it, clear the rest of its state, post.
   *
   * Called *after* the boundary's `clearStatusesForUris`, which is what puts
   * the earlier rows' marks back on the file.
   */
  private startRunRow(row: number): void {
    this.rowStartedAt = Date.now();
    // A section's loop starts over inside every run row, so the "k-th
    // iteration frame of this section" counter does too — otherwise run row
    // 2's first iteration would be counted as the run's second.
    this.sectionIterationsSeen.clear();
    this.setRowState(this.runTable(), row, { status: 'running' });
    this.postRows();
  }

  /**
   * A run row's steps have ended. `failure` is the step:fail this row died
   * at, or null when it passed.
   */
  private endRunRow(
    row: number,
    failure: RowFailure | null,
    text: string,
  ): void {
    const table = this.runTable();
    const entry = table?.rows.find((r) => r.row === row);
    const durationMs =
      this.rowStartedAt === null ? undefined : Date.now() - this.rowStartedAt;
    this.rowStartedAt = null;
    if (failure) {
      // A failure in another FILE — a `[skill:]` body this row descended into
      // — has no ordinal and no step text here: both would be read out of the
      // test document at a line that belongs to the skill. It names the file
      // instead (§Hovers).
      const sourceName = basenameOfSource(failure.sourceUri);
      const ordinal = sourceName === undefined ? mainFlowOrdinal(text, failure.line) : null;
      const stepText = sourceName === undefined ? stepTextAt(text, failure.line) : null;
      this.setRowState(table, row, {
        status: 'failed',
        detail: rowFailureDetail('run', ordinal, sourceName),
        hover: rowFailureError({
          kind: 'run',
          row,
          stepOrdinal: ordinal,
          ...(stepText && { stepText }),
          ...(sourceName !== undefined && { sourceName }),
          error: failure.error,
          ...(entry?.values && { values: entry.values }),
        }),
        ...(durationMs !== undefined && { durationMs }),
      });
    } else {
      this.setRowState(table, row, {
        status: 'passed',
        ...(durationMs !== undefined && { durationMs }),
      });
    }
    this.postRows();
  }

  /**
   * A looped section body has entered its iteration: band that row of the
   * section's table.
   *
   * Driven by the frame rather than by anything client-side, because the
   * section loop is the server's — `frame.iteration` is the only thing that
   * knows which row is running, and it carries the TABLE position, so a
   * narrowed run still bands the row the author sees.
   *
   * The frame has to be one of THIS document's sections. A looped section
   * inside a skill file arrives with that file's `uri` and its own name, and a
   * name is not unique across files — so a skill with a `### Upload each
   * statement` would have painted the test file's table of the same name, for
   * iterations of a table that is not on screen. The same fsPath comparison
   * `sectionPauseAt` makes (`frame.uri` is a path, not a `file://` URI).
   */
  private startSectionIteration(frame: FrameInfo): void {
    if (frame.iteration === undefined || !frame.skillName) return;
    if (frame.uri !== this.document.uri.fsPath) return;
    const table = this.sectionTable(frame.skillName);
    if (!table) return;
    const row = this.rowForIteration(frame);
    this.sectionIterationFrames.set(frame.id, {
      section: frame.skillName,
      row,
      startedAt: Date.now(),
    });
    this.setRowState(table, row, { status: 'running' });
    this.postRows();
  }

  /**
   * Which row of the section's table this iteration frame is, when the client
   * knows better than the frame does.
   *
   * `rowNumbers`/`rowCount` are new optional fields on a section payload, and
   * an older Sessions API server drops what it does not know: it receives one
   * row, numbers it `iteration 1 of 1`, and the extension would paint row 1 of
   * a run narrowed to row 2 — green mark on the wrong line, `(1/1)` in the
   * report, no error anywhere. The client shipped the rows, so it knows what
   * the k-th of them is called; that answer wins, and the mismatch is said out
   * loud once because the *report* is still wrong and only a server restart
   * fixes that.
   */
  private rowForIteration(frame: FrameInfo): number {
    const requested = frame.skillName ? this.sectionRowsOfRun?.[frame.skillName] : undefined;
    if (!requested) return frame.iteration ?? 1;
    const k = this.sectionIterationsSeen.get(frame.skillName!) ?? 0;
    this.sectionIterationsSeen.set(frame.skillName!, k + 1);
    const row = requested[k];
    if (row === undefined) return frame.iteration ?? 1;
    if (frame.iteration !== row && !this.oldServerNumberingWarned) {
      this.oldServerNumberingWarned = true;
      this.postOutput(
        `${frame.skillName} — the server numbered this iteration ` +
          `${frame.iteration ?? '?'} of ${frame.iterationCount ?? '?'}; restart or ` +
          'update the Sessions API server for correct row numbering in the report',
        'warn',
      );
    }
    return row;
  }

  /** The matching `frame:pop`: pass, or fail when a step:fail arrived inside. */
  private endSectionIteration(frameId: string): void {
    const active = this.sectionIterationFrames.get(frameId);
    if (!active) return;
    this.sectionIterationFrames.delete(frameId);
    const table = this.sectionTable(active.section);
    const entry = table?.rows.find((r) => r.row === active.row);
    const failure = this.frameFailures.get(frameId);
    const durationMs = Date.now() - active.startedAt;
    if (failure) {
      const text = this.document.getText();
      // As for a run row: a failure that happened in a skill the body called
      // is not a body step, and reading `text` at its line would quote one.
      const sourceName = basenameOfSource(failure.sourceUri);
      const ordinal = sourceName === undefined ? sectionBodyOrdinal(text, failure.line) : null;
      const stepText = sourceName === undefined ? stepTextAt(text, failure.line) : null;
      this.setRowState(table, active.row, {
        status: 'failed',
        detail: rowFailureDetail('section', ordinal, sourceName),
        hover: rowFailureError({
          kind: 'section',
          row: active.row,
          stepOrdinal: ordinal,
          ...(stepText && { stepText }),
          ...(sourceName !== undefined && { sourceName }),
          error: failure.error,
          ...(entry?.values && { values: entry.values }),
        }),
        durationMs,
      });
      // A failed iteration ends the run (part B's rule), so every LATER row
      // of this table is a row the loop planned and never reached.
      this.skipRestOfTable(table, active.row, {
        kind: 'iteration-failed',
        iteration: active.row,
      });
    } else {
      this.setRowState(table, active.row, { status: 'passed', durationMs });
    }
    this.postRows();
  }

  /** Mark every row of `table` after `after` as never-reached, with the
   *  reason. Rows that already ran keep their marks — skip means "was going
   *  to run and did not", not "has no result". */
  private skipRestOfTable(
    table: RowTableState | undefined,
    after: number,
    reason: RowSkipReason,
  ): void {
    if (!table) return;
    for (const entry of table.rows) {
      if (entry.row <= after) continue;
      // Not in this run's plan: it was never going to run, so "not run" would
      // be a claim about a run it had nothing to do with (decision 6).
      if (!entry.planned) continue;
      if (entry.status !== 'pending') continue;
      this.setRowState(table, entry.row, {
        status: 'skipped',
        detail: rowSkipDetail(reason),
        hover: rowSkipHover(table.kind, entry.row, reason),
      });
    }
  }

  /**
   * The run is over: close out every table and post the matrix one last time.
   *
   * A row still `running` was interrupted, and every `pending` row after it is
   * one the loop planned and never reached. `reason` is the ways that happens,
   * and they are not interchangeable to a reader: a pause is one gesture from
   * running (so its hover says so), a Stop is somebody's doing, and a run that
   * ended on an error is neither — telling the author their rows were "not run
   * (stopped)" sends them looking for a Stop nobody pressed.
   *
   * A PAUSE is the exception to the first sentence. The row it parked in is
   * not interrupted, it is unfinished: a Continue will run the rest of its
   * steps, and until then the band is the truest thing on screen about where
   * the run is. So it stays `running` and only the rows after it are settled.
   */
  private finalizeRowTables(reason: RowSkipReason): void {
    if (this.rowTables.length === 0) return;
    const parked = reason.kind === 'paused';
    for (const table of this.rowTables) {
      // Planned rows only, throughout: an unselected row's mark is last run's
      // news, and reading it here would let it decide where "the loop got to".
      const planned = table.rows.filter((r) => r.planned);
      const runningRow = planned.find((r) => r.status === 'running');
      if (runningRow) {
        // How long the row got. The only number an unfinished row has, and
        // what puts it in the Output's per-row list alongside the rows that
        // finished — a row with no line at all made the `Rows:` summary's
        // parts sum to one less than the count.
        const startedAt =
          table.kind === 'run'
            ? this.rowStartedAt
            : ([...this.sectionIterationFrames.values()].find(
                (f) =>
                  typeof table.table === 'object' &&
                  f.section === table.table.section &&
                  f.row === runningRow.row,
              )?.startedAt ?? null);
        const durationMs = startedAt === null ? undefined : Date.now() - startedAt;
        // A pause leaves the row where the run IS: unfinished, not
        // interrupted, and one Continue from being decided. It keeps the band
        // and gains nothing else.
        //
        // Anything else cut it off, and the ■ is the one mark with no other
        // explanation anywhere — the row has no failure and no skip reason —
        // so it carries its own, worded by what actually ended the run.
        this.setRowState(
          table,
          runningRow.row,
          parked
            ? { status: 'running', ...(durationMs !== undefined && { durationMs }) }
            : {
                status: 'stopped',
                detail: 'stopped',
                hover: rowStoppedHover(table.kind, runningRow.row, reason),
                ...(durationMs !== undefined && { durationMs }),
              },
        );
      }
      const reached = runningRow
        ? runningRow.row
        : Math.max(0, ...planned.filter((r) => r.status !== 'pending').map((r) => r.row));
      // Nothing ran at all (a run that never reached the loop) — the rows are
      // untouched, not skipped: skip is for rows the loop planned.
      if (reached > 0) this.skipRestOfTable(table, reached, reason);
      this.applyWorstAcrossRunRows(table);
    }
    this.postRows();
    this.rowStartedAt = null;
    this.sectionIterationFrames.clear();
    this.sectionIterationsSeen.clear();
    this.frameFailures.clear();
  }

  /**
   * The rows that make this run loop, or null when the file has none.
   *
   * A malformed table is reported and the run goes ahead as a single
   * un-looped run, rather than being refused: the parse error is a fact about
   * the table, and refusing to run the steps because of it would be a worse
   * trade than running them once with the placeholders unresolved — which the
   * author will see immediately in the step text.
   */
  private readDataRows(
    text: string,
    filePath: string,
    log: (msg: string) => void,
  ): Array<Record<string, string>> | null {
    try {
      const scan = parseDataRows(text, filePath);
      if (!scan) return null;
      log(`data table: ${scan.rows.length} row(s), columns [${scan.columns.join(', ')}]`);
      return scan.rows;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postOutput(`Data table not read: ${message}`, 'error');
      log(`data table error: ${message}`);
      return null;
    }
  }

  /**
   * Say so when a `### Section`'s table cannot be read.
   *
   * Three separate places swallow this throw on purpose — `buildSectionsPayload`
   * (so a bad table does not stop the run), `dataTablesOf` (so it does not take
   * the step marks down with it) and `scanTables` (so a selection cannot name
   * rows of a table that does not parse) — and the sum of three sensible local
   * decisions was that nothing ever told the author. The section then runs once
   * with its `{{placeholders}}` unresolved, which looks like a model failure
   * three steps later.
   *
   * One message per run: `scanSectionDataTables` stops at the first bad table,
   * so there is only ever one to report anyway.
   */
  private reportSectionTableErrors(
    text: string,
    filePath: string,
    log: (msg: string) => void,
  ): void {
    try {
      scanSectionDataTables(text, filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postOutput(`Section data table not read: ${message}`, 'error');
      log(`section data table error: ${message}`);
    }
  }

  /**
   * Close out a data-driven run: repaint the gutter with each line's worst
   * status, print the per-row summary, and ask the server to render the run's
   * one report.
   *
   * The repaint is a controller→extension message rather than a run event on
   * purpose. Run events also reach the Test Explorer's listener, which renders
   * each `step:fail` as a test message — replaying them here would double-count
   * every failure in the Explorer while fixing the gutter.
   */
  private async finishRowRun(args: {
    client: ApiClientLike;
    sessionId: string;
    rowPlan: Array<{ row: number; values: Record<string, string> } | null>;
    rowOutcomes: Array<{ row: number; values: Record<string, string>; failed: boolean }>;
    attemptedRows: Set<number>;
    /** Why the loop ended, for the rows it never reached. The same value
     *  `finalizeRowTables` painted with, so the Output log and the gutter
     *  cannot give a row two different reasons. */
    endReason: RowSkipReason;
    /** A batch run closes its session as it finishes, so the "which row is
     *  the browser on" line is only true of an interactive one. */
    batchMode: boolean;
    log: (msg: string) => void;
  }): Promise<void> {
    const { client, sessionId, rowPlan, rowOutcomes, attemptedRows, endReason, log } = args;
    const ran = attemptedRows;
    const notRunReason = rowSkipDetail(endReason).replace(/^not run \((.*)\)$/, '$1');
    // PLANNED rows only. An unselected row was never part of this run, so it
    // is not "not run" — passing it to `finalizeRowReport` would put a row in
    // the report's matrix that nobody asked to run (decision 6, §The report).
    const notRun = rowPlan
      .map((planned) => ({ row: planned?.row ?? 0, values: planned?.values ?? {} }))
      .filter((r) => !ran.has(r.row))
      .map((r) => ({ ...r, reason: notRunReason }));

    // Worst-status repaint. A green gutter after a red row is a lie, so a line
    // that failed on any row stays red — with the failing rows named in the
    // hover, since the line itself can no longer say which run it belonged to.
    if (this.rowFailuresByLine.size > 0) {
      const failures = [...this.rowFailuresByLine.entries()].map(([line, rows]) => ({
        line,
        rows: [...rows].sort((a, b) => a - b),
      }));
      this.post({ type: 'rowSummary', uri: this.document.uri.toString(), failures });
    }
    this.rowFailuresByLine.clear();

    // Per-row lines, then the rows line the CLI prints. `detail` and
    // `durationMs` come off the matrix rather than being recomputed: the
    // gutter hover, the panel row and this line then say `failed at step 6`
    // and `7.4s` from one place, and cannot drift.
    //
    // The matrix is also where the STOPPED row comes from. Stop unwinds the
    // loop by throwing, so the row it interrupted never reaches
    // `rowOutcomes`, and its batch was sent so it is not in `notRun` either —
    // it used to have no line at all, while the summary counted it and the
    // gutter said `stopped`. `finalizeRowTables` has already marked it by the
    // time we get here, which is why it runs first.
    const table = this.runTable();
    const outcomeRows = new Set(rowOutcomes.map((o) => o.row));
    const stoppedRows = (table?.rows ?? []).filter(
      (r) => r.planned && r.status === 'stopped' && !outcomeRows.has(r.row),
    );
    // …and the PARKED row, for exactly the same reason. A pause ends the loop
    // after the current row, and that row is not finished: half its steps ran,
    // a Continue will run the rest. It is in neither `rowOutcomes` nor
    // `notRun`, so without its own line the summary would count a row that has
    // no line, or (worse) claim it passed.
    const pausedRows = (table?.rows ?? []).filter(
      (r) => r.planned && r.status === 'running' && !outcomeRows.has(r.row),
    );
    const lines: Array<{ row: number; text: string; level: 'info' | 'warn' | 'error' }> = [
      ...rowOutcomes.map((outcome) => {
        const entry = table?.rows.find((r) => r.row === outcome.row);
        return {
          row: outcome.row,
          text: rowOutcomeLine({
            row: outcome.row,
            failed: outcome.failed,
            ...(outcome.failed && entry?.detail !== undefined && { detail: entry.detail }),
            ...(entry?.durationMs !== undefined && { durationMs: entry.durationMs }),
          }),
          level: (outcome.failed ? 'error' : 'info') as 'info' | 'error',
        };
      }),
      ...stoppedRows.map((entry) => ({
        row: entry.row,
        text: rowOutcomeLine({
          row: entry.row,
          failed: false,
          stopped: true,
          ...(entry.durationMs !== undefined && { durationMs: entry.durationMs }),
        }),
        level: 'warn' as const,
      })),
      ...pausedRows.map((entry) => ({
        row: entry.row,
        text: rowOutcomeLine({
          row: entry.row,
          failed: false,
          paused: true,
          ...(entry.durationMs !== undefined && { durationMs: entry.durationMs }),
        }),
        level: 'warn' as const,
      })),
      ...notRun.map((skipped) => ({
        row: skipped.row,
        text: `  Row ${skipped.row}: not run (${skipped.reason})`,
        level: 'warn' as const,
      })),
    ].sort((a, b) => a.row - b.row);
    for (const line of lines) this.postOutput(line.text, line.level);
    if (rowPlan.length > 0) {
      // The parts sum to `planned`, always: every row the loop planned is in
      // exactly one of the five buckets.
      this.postOutput(
        rowsSummaryLine({
          planned: rowPlan.length,
          passed: rowOutcomes.filter((o) => !o.failed).length,
          failed: rowOutcomes.filter((o) => o.failed).length,
          stopped: stoppedRows.length,
          paused: pausedRows.length,
          notRun: notRun.length,
        }),
        'info',
      );
    }
    // Whose browser is still open. After a multi-row run the interactive
    // session belongs to the LAST row that ran — the last SELECTED row, once
    // a subset can be chosen — so Re-run from step N and the Variables view
    // are about that row, not row 1 and not the last row of the table (rows
    // story, decision 7: "the output log says so").
    const lastRan = rowOutcomes[rowOutcomes.length - 1];
    if (rowOutcomes.length > 1 && lastRan && !args.batchMode) {
      this.postOutput(
        `Session left on row ${lastRan.row} — Re-run from step N re-runs that row.`,
        'info',
      );
    }

    // Never fails the run: report generation has that posture everywhere else,
    // and a run whose steps all passed must not go red because the render did
    // not.
    if (!client.finalizeRowReport) {
      log('row run finalise skipped: this client cannot render a merged report');
      return;
    }
    try {
      const result = await client.finalizeRowReport(sessionId, notRun);
      if (result) {
        this.lastResolvedReportPath = result.reportPath;
        this.postOutput(`Report: ${result.reportPath}`, 'info');
        log(`row run report: ${result.reportPath}`);
      } else {
        log('row run finalise: nothing accumulated on the server');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postOutput(`Could not render the run's report: ${message}`, 'warn');
      log(`row run finalise failed: ${message}`);
    }
  }

  private async runStepBlock(args: {
    block: ClassifiedStep[];
    client: ApiClientLike;
    sessionId: string;
    env: Record<string, string>;
    /** Resolved env name to send to the server. `null` means none active. */
    envName: string | null;
    params: Record<string, string>;
    sessionConfig: { baseUrl?: string; timeout?: string; viewport?: string };
    logging?: LoggingOverride;
    signal: AbortSignal;
    log: (line: string) => void;
    /** Raw per-test `## Config: cache:` value (e.g. "on" / "off"), if the
     *  test declared one. Overrides the project's aiui.config.json
     *  `cache.enabled` for this run; see `resolveCacheOverride`. */
    cacheOverride?: string;
    /** Which data row this batch runs, when the test has a data table. The
     *  server accumulates such a batch instead of writing it a report. */
    dataRow?: { row: number; count: number; values: Record<string, string> };
    /** Initial stepMode to send with the request body — when set, the
     *  server pauses between steps and the run is driven by `run-control`
     *  POSTs from the extension. */
    stepMode?: StepMode;
    /** Phase 5 — when true, the request body carries `pauseAtNextTool: true`.
     *  The server emits `tool:awaiting-debugger` before the next
     *  `[tool: ...]` step and parks for a debugger-attach ack. */
    pauseAtNextTool?: boolean;
    /** Code-behind sibling: the body carries `pauseAtNextCodeBehind: true`
     *  so the server pauses into the first step's entry, if any
     *  (stories/codebehind-debugging.md). */
    pauseAtNextCodeBehind?: boolean;
    /** "Re-run a skill step with its variables": start the (re-expanded)
     *  invocation partway in at `startAt` and seed `seedScope` before running.
     *  Forces the per-step cache off for this request (the server also does,
     *  defensively) so an edited value re-plans instead of replaying a frozen
     *  cached action list. */
    rerun?: {
      startAt: { uri: string; line: number };
      endAt?: { uri: string; line: number };
      seedScope?: Record<string, string>;
    };
    /** Compile the steps this block executes, as it executes them
     *  (stories/compile-as-you-go.md). Rides the ordinary step request. */
    compile?: 'run' | 'steps';
    /** This block is not the first of its logical run — continue the compile
     *  already open in the session rather than starting a new one. */
    compileContinues?: boolean;
    /** Section attribution for the entries this block compiles. */
    compileScope?: { section: string };
    /** This block belongs to a compile of this MODE but compiles nothing of
     *  its own — rows 2..N of a data-driven one. Keeps the two things the
     *  server decides per batch from the mode: the AI switch's compile
     *  carve-out (stories/run-settings.md §9), and code-behind execution off
     *  for `'steps'`. Asks for no compile. Never sent with `compile`, which the
     *  server refuses. */
    withinCompileRun?: 'run' | 'steps';
    /** Omit the per-URI breakpoint map from the request — a single-step
     *  slice pausing at its own breakpoint runs nothing. */
    suppressServerBreakpoints?: boolean;
  }): Promise<boolean> {
    const { block, client, sessionId, env, envName, params, sessionConfig, logging, signal, log, cacheOverride, dataRow, stepMode, pauseAtNextTool, pauseAtNextCodeBehind, rerun, compile, compileContinues, compileScope, withinCompileRun, suppressServerBreakpoints } = args;
    const includeConfig = !this.configSentForSession;
    const stepInstructions = block.map((b) => (b.kind === 'step' ? b.instruction : ''));
    const stepLines = block.map((b) => b.line);
    // Full step list (live document buffer) for cache-hash stability across
    // multi-batch runs. When the user pauses at a breakpoint and resumes,
    // batch 1 has steps 1..N-1 and batch 2 has steps N..end. The server
    // hashes `fullSteps` to keep the cache identity stable across both.
    // We use the live buffer (not disk) so unsaved edits invalidate cache
    // correctly — otherwise an edit-but-don't-save followed by Continue
    // would replay a stale plan.
    const fullStepInstructions = extractSteps(this.document.getText())
      .map((s) => s.instruction);

    // Inline section definitions, rebuilt from the LIVE buffer on every
    // request — initial runs, breakpoint continuations and partial re-runs
    // alike. The server holds no cross-batch document state, so a
    // continuation that omitted these would expand differently from the
    // batch before it and hash differently too. Same reason `fullSteps` is
    // re-sent, and same reason it reads the buffer rather than disk.
    // …which is exactly why a BODY narrowing has to be re-checked here.
    // `runSteps` is a list of positions, and the buffer this rebuild reads may
    // have been edited since the run decided them. Refused, not repaired:
    // there is no honest guess at which steps the author meant once the text
    // under those positions moved.
    const drift = this.narrowedBodyDrift(this.document.getText());
    if (drift !== null) {
      this.refuseStaleNarrowing(drift, log, 'narrowed section body changed mid-run');
      return false;
    }
    let sections: ReturnType<typeof buildSectionsPayload>;
    try {
      sections = buildSectionsPayload(
        this.document.getText(),
        this.sectionRowsOfRun,
        this.sectionStepsOfRun,
      );
    } catch (err) {
      if (!(err instanceof SectionNarrowingError)) throw err;
      this.refuseStaleNarrowing(err.message, log, 'narrowed section body no longer fits');
      return false;
    }

    // Resolve the project's skills directory so the server can expand
    // `[skill: ...]` lines and emit `frame:push` / `frame:pop` events around
    // their bodies. Without a resolved skillsDir the server falls back to
    // the legacy raw-step path — fine for tests that never reference a
    // skill, but skill invocations would hit the AI as literal strings.
    const projectDirs = resolveProjectDirs(this.document.uri);
    const skillsDir = projectDirs?.skillsDir ?? null;
    const toolsDir = projectDirs?.toolsDir ?? null;
    // Step cache is opt-in. Baseline is the project's nearest aiui.config.json
    // `cache.enabled`; a per-test `## Config: cache: on|off` overrides it for
    // this run. No config + no override leaves it off (flag omitted; server
    // defaults off).
    const cacheEnabled = resolveCacheOverride(cacheOverride, projectDirs?.cacheEnabled === true);
    const testFilePath = this.document.uri.fsPath;
    // The test's frontmatter dataSources (name → path) so the server can
    // resolve `${<name>.X}` test-level named sources on its side too.
    const dataSources = parseFrontmatter(this.document.getText()).dataSources;

    const events = client.streamSteps(
      sessionId,
      {
        steps: stepInstructions,
        fullSteps: fullStepInstructions,
        sourceLines: stepLines,
        env,
        ...(envName && { envName }),
        ...(dataSources && Object.keys(dataSources).length > 0 && { dataSources }),
        ...(includeConfig && Object.keys(sessionConfig).length > 0 && {
          config: sessionConfig,
        }),
        ...(Object.keys(params).length > 0 && { parameters: params }),
        ...(logging && { logging }),
        ...(skillsDir && { skillsDir }),
        ...(toolsDir && { toolsDir }),
        // Omitted entirely when the file defines none: `{}` is truthy, and
        // several server gates would read it as "this run has sections",
        // moving every sectionless run onto the expansion path.
        ...(sections && { sections }),
        // A re-run forces the cache off (see `rerun` doc) so an edited value
        // re-plans rather than replaying a frozen cached action list. So does
        // a data-driven row: the cache is keyed per step line and rewrites
        // only an action's `value`, so an assertion whose expectation came
        // from a row would replay row 1's on every row
        // (stories/data-driven-rows.md, decision 8).
        ...(cacheEnabled && !rerun && dataRow === undefined && { cacheEnabled: true }),
        // A batch carrying `dataRow` writes no report: its results join the
        // server's row accumulator, and `finalizeRowReport` renders the one
        // report when the loop ends.
        ...(dataRow !== undefined && {
          dataRow: dataRow.row,
          dataRowCount: dataRow.count,
          dataRowValues: dataRow.values,
        }),
        testFilePath,
        ...(stepMode && { stepMode }),
        ...(pauseAtNextTool && { pauseAtNextTool: true }),
        ...(pauseAtNextCodeBehind && { pauseAtNextCodeBehind: true }),
        ...(rerun && {
          startAt: rerun.startAt,
          ...(rerun.endAt && { endAt: rerun.endAt }),
          ...(rerun.seedScope && { seedScope: rerun.seedScope }),
        }),
        ...(this.breakpointsByUriProvider && suppressServerBreakpoints !== true && (() => {
          const map = this.breakpointsByUriProvider!();
          return Object.keys(map).length > 0 ? { breakpointsByUri: map } : {};
        })()),
        ...(compile && { compile }),
        ...(compile && compileContinues && { compileContinues: true }),
        ...(compile === 'steps' && compileScope && { compileScope }),
        // Never alongside `compile` — the server refuses that pair, and the
        // caller already gates on `rowCompile === undefined`. Narrowed again
        // here for the same reason `compileScope` is: this is the one place
        // that knows what actually goes on the wire.
        ...(compile === undefined && withinCompileRun !== undefined && { withinCompileRun }),
      },
      signal,
    );

    let sawFail = false;
    let cachedCount = 0;
    let codeBehindCount = 0;
    let staleCount = 0;
    /** Server-attributed cost of the steps that healed; 0 when unattributed. */
    let healedTokens = 0;
    let passCount = 0;
    /**
     * Steps this run did not take — BOTH producers, counted the same way
     * (`step:skip`, and `step:pass` carrying `output: 'skipped'`).
     *
     * Its own counter and never folded into `passCount`, which is the whole
     * point: a skipped step is neither a pass nor a failure, and a run that
     * skipped three of twelve reported `✓ 12 passed` while the panel header
     * beside it said `9 passed, 3 skipped`. Same rule as `stepsSummaryText`
     * (steps-summary-core.ts) and the panel (testbench-runner.jsx).
     *
     * The population differs from the panel's by construction and always has:
     * this counts EVENTS and the panel counts numbered LINES in the open
     * document, so the two disagree wherever one line produces more or fewer
     * than one event. Three ways that happens, all of them normal:
     *
     *  - a skill body's steps each send an event, and none of them is a line
     *    of the open document (a `### Section` body's steps ARE lines of it —
     *    `classifyLines` marks them `section-step` — so a section tail counts
     *    the same on both surfaces);
     *  - a chain member whose tail is a plain instruction expands to TWO steps
     *    on one source line — the guard row and the tail — so that line is
     *    counted twice here and once there;
     *  - a loop body's line sends one event per pass.
     *
     * Deduping by `event.line` would fix the first two and break the third,
     * which is the one that matters most. It is the RULE that has to agree —
     * a skipped step is never a pass on any surface — not the totals.
     */
    let skipCount = 0;
    /**
     * Steps that failed and the run carried on past — an `otherwise continue`
     * tail (stories/step-failure-outcomes.md, decision 6).
     *
     * Its own counter for the reason `skipCount` is: `passCount` is what did its
     * work, and a tolerated failure did not. Named in the closing tally because the
     * run ends green and the per-step ⚠ has scrolled by then — `✓ 7 passed` with no
     * mention of the eighth step is what this counter prevents.
     */
    let toleratedCount = 0;
    for await (const event of events) {
      // The first event proves the server accepted the request and now holds a
      // session for it — created with this request's `config` when this was the
      // request that carried one (`includeConfig`); `markConfigSent` ignores
      // the value on every later call, which is what keeps the remembered
      // viewport describing the live browser rather than the current file.
      this.markConfigSent(sessionConfig.viewport);
      // The compile riding this run (stories/compile-as-you-go.md). Logged,
      // never folded into the gutter: by the time an entry is generated its
      // step has already painted ✓, and repainting ▶ on it would undo that.
      if (event.type === 'compile:progress') {
        // Numbers only — no log line (see `compileLogLine`). `runEnded` is the
        // server saying the steps are done, which is the strip's cue; frames
        // before it belong to a run that is still painting its own progress.
        this.sawCompileProgress = true;
        const tail = this.tailFrom(event);
        if (event.runEnded === true) this.beginCompileTail(tail);
        else if (this.compileStrip !== null) this.updateCompileTail(tail);
        continue;
      }
      if (event.type === 'compile:step' || event.type === 'compile:result') {
        // An older server sends no `compile:progress` at all, so its first
        // compile frame is the only cue the tail has begun; the strip then runs
        // in its indeterminate form. On a current server this must NOT fire —
        // its start frames arrive mid-run, behind a progress frame that has
        // already set the flag.
        if (event.type === 'compile:step' && !this.sawCompileProgress) {
          this.beginCompileTail();
        }
        const line = compileLogLine(event);
        if (line !== null) this.logCompileLine(line, log);
        if (event.type === 'compile:result') {
          this.endCompileTail();
          this.compileResult = {
            ok: event.status !== 'failed',
            status: event.status,
            files: event.files,
            summary: event.summary,
            ...(event.status === 'failed' && {
              error: event.summary.error ?? 'the compile produced nothing',
            }),
          };
          this.logCompileLine(compileResultLine(event), log);
        }
        continue;
      }
      // How the step passed — the textual half of what the gutter glyphs say.
      // ⚡ replayed a recorded transcript, </> ran compiled code, ⚠ healed under
      // AI because the compiled entry threw.
      if (event.type === 'step:pass') {
        // A step the run decided not to take rides the pass event (the older
        // of the two skip conventions) but did not run, so the log says so
        // rather than claiming a ✓ (stories/control-flow.md).
        //
        // Counted as a SKIP, not as a pass. One accounting rule, on every
        // surface, for both producers: `passCount` is what EXECUTED. The panel
        // header and the `## Steps` decoration have always said `9 passed,
        // 3 skipped` for such a run; this line used to say `✓ 12 passed`
        // beside them, and a green tally that includes steps that never ran is
        // the failure direction this codebase names as worst. The server's own
        // `stepsCompleted` does count one of the two producers — that
        // divergence is real and documented (stories/control-flow.md §"What
        // `stepsCompleted` counts"), but it is a progress-bar denominator, not
        // a claim that N steps passed.
        //
        // `event.reason` is present on a current server and absent on an older
        // one; `skipRunLogLine` reads without it either way.
        if (isSkippedPass(event)) {
          skipCount += 1;
          log(skipRunLogLine(event.line, event.reason));
        } else {
          passCount += 1;
          if (event.codeBehindStale) {
            staleCount += 1;
            log(`⚠ step ${event.line} passed under AI — code-behind failed: ${event.codeBehindStale.error}`);
          } else if (event.fromCodeBehind) {
            codeBehindCount += 1;
            log(`✓ step ${event.line} passed (code-behind)`);
          } else if (event.fromCache) {
            cachedCount += 1;
            log(`✓ step ${event.line} passed (cached)`);
          } else {
            log(`✓ step ${event.line} passed`);
          }
        }
      } else if (event.type === 'step:fail') {
        // The error, in the run log — with the code-behind crash when the
        // failure has one behind it (the entry itself failing, or a heal
        // whose AI attempt failed too). Same vocabulary as every other
        // single-line surface.
        //
        // The two outcome flags change the SENTENCE and nothing else about this
        // branch (decisions 2 and 6). A tolerated failure is counted apart, below,
        // because the tally must not call it a pass; a deliberate one is an ordinary
        // failure that stopped the run and only says so differently.
        const described = describeStepFailure(event);
        if (event.tolerated) {
          toleratedCount += 1;
          log(toleratedRunLogLine(event.line, described, event.warning));
        } else if (event.deliberate) {
          log(deliberateRunLogLine(event.line, described));
        } else {
          log(`✗ step ${event.line} failed: ${described}`);
        }
      } else if (event.type === 'step:skip') {
        // A line an `If … then return` left behind. It carries its own reason
        // — `Not run: step 3 returned from "Sign in"` — built server-side by
        // the one formatter the report also uses, so the log and the report
        // cannot describe the same skip in two different ways. Counted as a
        // skip, exactly as the other producer above is: `passCount` is what
        // EXECUTED, and a skipped step spent nothing.
        skipCount += 1;
        log(skipRunLogLine(event.line, event.reason));
      } else if (event.type === 'output') {
        // The compile's own prose — the run-end forecast, and the warning a
        // failed generation leaves — plus anything else the server says out of
        // band. Logged as what it says rather than as `event output`, which is
        // all the fall-through below ever made of it.
        log(`[${event.kind}] ${event.msg}`);
      } else {
        log(`event ${event.type}${'line' in event ? ` line=${event.line}` : ''}`);
      }
      // Track the step that's currently executing — used as the resume
      // point if the user pauses mid-step.
      if (event.type === 'step:start') this.lastStepStartLine = event.line;
      // A TOLERATED failure is exempt (decision 6). `sawFail` is this block's whole
      // verdict — it becomes the `ok` the row loop reads as `anyFailed`, deciding
      // the row's mark, the Test Explorer item and whether the batch goes red — and
      // the run continued past this step by the author's own instruction.
      // `done.status` already excludes it, so the two agree.
      if (event.type === 'step:fail' && !event.tolerated) sawFail = true;
      if (event.type === 'done') {
        // Capture the report path so the "Open Last Report" surface can
        // resolve it later. Older servers omit this field — we leave
        // any previous value in place rather than clearing on every
        // run boundary, matching the spec's lifecycle rules.
        if (event.reportPath) this.lastResolvedReportPath = event.reportPath;
        // What the healed steps actually cost. The count is already tracked
        // locally from step events; the tokens can only come from the server,
        // which is the half that was invisible before — a broken entry looks
        // like a slightly slower green run forever.
        if (event.healed) healedTokens = event.healed.tokens;
        // A server-level error (or an explicit failed status) that DIDN'T
        // surface as a step:fail must still fail the block — otherwise a
        // session-setup error like an invalid baseUrl ("Server error:
        // page.goto: Cannot navigate to invalid URL …", delivered as
        // output:error + done:'error') would let the test pass green.
        // 'aborted' is a user stop, not a failure, so it's excluded.
        if (event.status === 'error' || event.status === 'failed') sawFail = true;
        continue;
      }
      this.emitRunEvent(event);
    }
    if (passCount > 0 || skipCount > 0 || toleratedCount > 0) {
      // Built by `runLogTallyLine` rather than here, so `node --test` can pin
      // the sentence: this method imports `vscode` and is unreachable from
      // that suite, which is how `✓ 12 passed` for a run with three skips
      // survived beside a panel header that said `9 passed, 3 skipped`.
      log(
        runLogTallyLine({
          passed: passCount,
          skipped: skipCount,
          tolerated: toleratedCount,
          cached: cachedCount,
          codeBehind: codeBehindCount,
          stale: staleCount,
        }),
      );
      if (staleCount > 0) {
        // Naming the price is the point of the line, not decoration: the
        // count alone reads as a one-off, and it is not — the entry is still
        // broken, so the same AI turns are paid on every run until someone
        // repairs it. Tokens are omitted rather than shown as 0 when the
        // server did not attribute them (an older server, or a path that
        // does not track them).
        const cost = healedTokens > 0 ? ` (${formatTokens(healedTokens)} tokens)` : '';
        log(
          `  ${staleCount} step(s) healed under AI because their code-behind failed${cost}.`,
        );
        log('  Repair this step from the ⚠ gutter, or it costs that again every run.');
      }
    }
    return !sawFail;
  }

  private async runInteractive(args: {
    hint: string;
    client: ApiClientLike;
    sessionId: string;
    env: Record<string, string>;
    envName: string | null;
    params: Record<string, string>;
    sessionConfig: { baseUrl?: string; timeout?: string; viewport?: string };
    logging?: LoggingOverride;
    signal: AbortSignal;
    log: (line: string) => void;
  }): Promise<boolean> {
    const { hint, client, sessionId, env, envName, params, sessionConfig, logging, signal, log } = args;

    const firstAnswer = await this.requestPrompt({ mode: 'interactive', message: hint });
    let answer: string | null = firstAnswer;

    while (answer !== null) {
      if (signal.aborted) return false;

      const action = interpretReplCommand(answer, () =>
        listStepInstructions(this.document.getText()),
      );

      if (action.kind === 'exit-section') return true;
      if (action.kind === 'quit-run') return false;

      if (action.kind === 'output') {
        this.postOutput(action.msg, action.level);
      } else if (action.kind === 'resume') {
        this.postOutput(
          '/resume is not yet supported in the testbench — use /continue or /exit, or run from the CLI for resume support.',
          'warn',
        );
      } else if (action.kind === 'screenshot') {
        this.postOutput(
          '/screenshot is not yet wired in the testbench — run from the CLI for on-demand captures.',
          'warn',
        );
      } else if (action.kind === 'send-step') {
        log(`interactive step: ${action.text}`);
        this.postOutput(`> ${action.text}`, 'info');
        try {
          const events = client.streamSteps(
            sessionId,
            {
              steps: [action.text],
              sourceLines: [0],
              // Carry the test file path so the server resolves the SAME project
              // root (and thus the same per-project env/data/config) it used for
              // the run this interactive step continues.
              testFilePath: this.document.uri.fsPath,
              env,
              ...(envName && { envName }),
              ...(() => {
                const ds = parseFrontmatter(this.document.getText()).dataSources;
                return ds && Object.keys(ds).length > 0 ? { dataSources: ds } : {};
              })(),
              ...(!this.configSentForSession &&
                Object.keys(sessionConfig).length > 0 && { config: sessionConfig }),
              ...(Object.keys(params).length > 0 && { parameters: params }),
              ...(logging && { logging }),
            },
            signal,
          );
          for await (const event of events) {
            // Same contract as the step-block loop: first mark wins, so an
            // interactive turn that omitted `config` never overwrites the
            // viewport the session's browser actually launched with.
            this.markConfigSent(sessionConfig.viewport);
            if (event.type === 'done') continue;
            this.emitRunEvent(event);
          }
        } catch (err) {
          this.postOutput(
            `interactive step errored: ${err instanceof Error ? err.message : String(err)}`,
            'error',
          );
        }
      }

      answer = await this.requestPrompt({ mode: 'interactive', message: hint });
    }
    return false;
  }

  private requestPrompt(opts: {
    mode: 'input' | 'interactive';
    message: string;
    varName?: string;
  }): Promise<string | null> {
    // Cancel any prior pending prompt so a stale resolver doesn't fire when
    // the new prompt resolves.
    if (this.pendingPrompt) {
      this.pendingPrompt.resolve(null);
      this.pendingPrompt = null;
    }

    if (opts.mode === 'input') {
      // One-shot input → use VS Code's native InputBox. Native styling, no
      // webview round-trip, free Esc-to-cancel + Enter-to-submit.
      return new Promise<string | null>((resolve) => {
        void vscode.window
          .showInputBox({
            prompt: opts.message || `Enter value for {{${opts.varName ?? 'input'}}}`,
            placeHolder: opts.varName ? `{{${opts.varName}}}` : undefined,
            ignoreFocusOut: true,
          })
          .then((value) => resolve(value === undefined ? null : value));
      });
    }

    // Interactive REPL — multi-turn composer in the sidebar webview.
    return new Promise<string | null>((resolve) => {
      this.pendingPrompt = { resolve };
      this.post({
        type: 'prompt',
        mode: opts.mode,
        message: opts.message,
        ...(opts.varName !== undefined && { varName: opts.varName }),
      });
    });
  }

  private postOutput(msg: string, kind: 'info' | 'warn' | 'error'): void {
    this.emitRunEvent({ type: 'output', msg, kind });
  }

  async runAll(): Promise<RunOutcome> {
    return this.runLines([]);
  }

  private fail(payload: ErrorPayload, log: (line: string) => void): RunOutcome {
    log(`${payload.code} ${payload.diagnosis}. ${payload.fix}`);
    this.post({ type: 'runError', payload });
    return { ok: false, error: payload };
  }
}

/**
 * Walk the classified items in order; if any step's source line is in the
 * breakpoint set, return everything *before* that step (so the breakpoint
 * line itself doesn't run) and the line we paused at. `skipFirst=true`
 * lets a Resume run past the breakpoint that triggered the pause.
 */
/**
 * `18234` → `18.2k`, for the healed-run cost in the run summary.
 *
 * Deliberately a copy of `formatTokenCount` in src/report/generator.ts rather
 * than an import: the extension bundle cannot reach `src/`, and the two
 * surfaces describe the SAME number to the same person — someone comparing the
 * summary line against the HTML report's banner must not see "18.2k" in one
 * and "18k" in the other. If either changes, change both.
 */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const k = tokens / 1000;
  return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k`;
}

function trimAtBreakpoint(
  items: ClassifiedStep[],
  breakpoints: Set<number>,
  skipFirst: boolean,
): { runnable: ClassifiedStep[]; pausedAt: number | null } {
  if (breakpoints.size === 0) return { runnable: items, pausedAt: null };
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    // Only proper step lines carry breakpoints; [input:] / [interactive]
    // markers don't appear under ## Steps as numbered list items.
    if (item.kind !== 'step') continue;
    if (!breakpoints.has(item.line)) continue;
    if (skipFirst && i === 0) continue;
    return { runnable: items.slice(0, i), pausedAt: item.line };
  }
  return { runnable: items, pausedAt: null };
}

/** The instruction text of the classified items that are STEPS — an
 *  `[input:]` or `[interactive]` marker calls nothing and names nothing. */
function instructionsOf(items: ClassifiedStep[]): string[] {
  return items
    .filter((c): c is Extract<ClassifiedStep, { kind: 'step' }> => c.kind === 'step')
    .map((c) => c.instruction);
}

function listStepInstructions(text: string): string {
  return extractSteps(text)
    .map((s) => `  ${s.line.toString().padStart(3, ' ')}  ${s.instruction}`)
    .join('\n');
}

/**
 * The ApiClientError an error is, or null. Duck-typed by name like
 * `isUserAbort` in runner-core: the extension bundles its own copy of that
 * module, so an error thrown by another copy (the integration suite's fake
 * client, an un-bundled caller) fails `instanceof` while being one.
 */
function asApiClientError(err: unknown): ApiClientError | null {
  if (err instanceof ApiClientError) return err;
  if (!err || typeof err !== 'object') return null;
  const e = err as { name?: unknown; kind?: unknown };
  return e.name === 'ApiClientError' && typeof e.kind === 'string' ? (err as ApiClientError) : null;
}

function mapApiErrorToPayload(
  err: unknown,
  ctx: { serverUrl: string; envPath: string },
): ErrorPayload {
  const apiErr = asApiClientError(err);
  if (apiErr) {
    switch (apiErr.kind) {
      case 'unauthorized':
        return reportError('TB011', { envPath: ctx.envPath, serverUrl: ctx.serverUrl });
      case 'not-found':
        return reportError('TB012', { serverUrl: ctx.serverUrl });
      case 'server-error':
        return reportError('TB013', {
          serverUrl: ctx.serverUrl,
          status: apiErr.status ?? 0,
          ...(apiErr.bodyExcerpt && { bodyExcerpt: apiErr.bodyExcerpt }),
        });
      case 'stream-dropped':
        return reportError('TB014', { serverUrl: ctx.serverUrl, reason: apiErr.message });
      case 'aborted':
        return reportError('TB014', { serverUrl: ctx.serverUrl, reason: 'aborted' });
      case 'connect-failed':
      default:
        return reportError('TB010', { serverUrl: ctx.serverUrl, reason: apiErr.message });
    }
  }
  const reason = err instanceof Error ? err.message : String(err);
  return reportError('TB010', { serverUrl: ctx.serverUrl, reason });
}

function timestamp(): string {
  const d = new Date();
  return d.toISOString().slice(11, 23);
}

function resolveValue(value: string, env: Record<string, string>): string {
  if (!value.startsWith('$')) return value;
  const name = value.slice(1);
  return env[name] ?? value;
}

const VALID_LOG_LEVELS = new Set(['silent', 'error', 'warn', 'info', 'debug']);
const VALID_LOG_FILES = new Set(['off', 'compact', 'full']);

type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
type LogFileMode = 'off' | 'compact' | 'full';

interface LoggingOverride {
  consoleLogLevel?: LogLevel;
  serverFileLogLevel?: LogFileMode;
}

function resolveLoggingOverride(
  rawConfig: Record<string, string>,
  settings: vscode.WorkspaceConfiguration,
): LoggingOverride | undefined {
  const settingLevel = (settings.get<string>('consoleLogLevel') ?? '').trim();
  const settingFile = (settings.get<string>('serverFileLogLevel') ?? '').trim();
  const fmLevel = (rawConfig['consoleLogLevel'] ?? '').trim();
  const fmFile = (rawConfig['serverFileLogLevel'] ?? '').trim();

  const levelRaw = fmLevel || settingLevel;
  const fileRaw = fmFile || settingFile;

  const out: LoggingOverride = {};
  if (levelRaw && VALID_LOG_LEVELS.has(levelRaw)) {
    out.consoleLogLevel = levelRaw as LogLevel;
  }
  if (fileRaw && VALID_LOG_FILES.has(fileRaw)) {
    out.serverFileLogLevel = fileRaw as LogFileMode;
  }
  return (out.consoleLogLevel || out.serverFileLogLevel) ? out : undefined;
}

/**
 * Resolve whether the step cache is on for this run. A per-test
 * `## Config: cache: <value>` wins when it parses to a clear boolean
 * (on/true/yes/enabled or off/false/no/disabled, case-insensitive); anything
 * else (absent, blank, unrecognized) falls back to the project's
 * aiui.config.json `cache.enabled` (`fallback`). Keeps the per-test escape
 * hatch decoupled from the project default in both directions.
 */
function resolveCacheOverride(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === 'yes' || v === 'enabled') return true;
  if (v === 'off' || v === 'false' || v === 'no' || v === 'disabled') return false;
  return fallback;
}

// `rowValuesText` — the one masked `k=v, k=v` text every surface shows — now
// lives in row-selection-core.ts, which the quick pick also reads it from.

/** 1-based position of `line` among the file's MAIN-FLOW steps, or null when
 *  it is not one (a body line, a line the file no longer has). */
function mainFlowOrdinal(text: string, line: number): number | null {
  const index = extractSteps(text).findIndex((s) => s.line === line);
  return index < 0 ? null : index + 1;
}

/** 1-based position of `line` within the body of the section that contains
 *  it — what "failed at body step 1" counts. */
function sectionBodyOrdinal(text: string, line: number): number | null {
  const index = sectionBodyLinesAt(text, line).indexOf(line);
  return index < 0 ? null : index + 1;
}

/**
 * The step's text as authored, without its list number, or null when the line
 * is not a numbered item.
 *
 * Read off the raw buffer rather than through `extractSteps`, because the
 * lines this is asked about are as often section-body steps as main-flow
 * ones and one lookup has to answer for both.
 */
function stepTextAt(text: string, line: number): string | null {
  const raw = text.split(/\r?\n/)[line - 1];
  if (raw === undefined) return null;
  const m = /^\s*\d+\.\s+(.*)$/.exec(raw);
  return m ? m[1]!.trim() : null;
}
