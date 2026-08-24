import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'node:path';
import {
  ApiClient,
  ApiClientError,
  EnvParseError,
  isUserAbort,
  classifySelectedSteps,
  composeEnv,
  extractSteps,
  resolveRunSelection,
  sectionBodyLinesAt,
  interpretReplCommand,
  maskIfSecret,
  parseConfig,
  parseFrontmatter,
  parseParameters,
  readEnvFile,
  readEnvOverlayFile,
  readMachineKey,
  reportError,
  resolveEnvFile,
  resolveSection,
  userRootEnvPath,
  type ClassifiedStep,
  type CompileEvent,
  type CompileResultEvent,
  type CompileSummary,
  type ErrorPayload,
  type FrameInfo,
  type HostToWebviewMsg,
  type RunEvent,
  type StepMode,
} from 'ai-ui-automation-runner-core';
import { getOutputChannel } from './output-channel.js';
import { EnvSelector } from './env-selector.js';
import { resolveProjectDirs } from './aiui-config.js';
import { buildSectionsPayload, preflightSections, sectionedSkillRefusal } from './sections.js';
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
    opts?: { pauseAtNextTool?: boolean },
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
        return `  ${' '.repeat(11)} ✗ step on line ${inner.line} — ${inner.error}`;
      }
      if (inner.type === 'output') return `  ${' '.repeat(11)} [${inner.kind}] ${inner.msg}`;
      return null;
    }
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
 * The one line a compile-mode run leaves in the log when its result arrives
 * (stories/compile-as-you-go.md). It stands in for the `compile:done`
 * narrative the boxed pipeline sends, which this path has no phase to hang
 * off — and it says "unproven" out loud, because that is the trade this
 * feature makes: no Replay rounds, and the author's next ordinary run is the
 * proof.
 */
export function compileResultLine(event: CompileResultEvent): string {
  const summary = event.summary;
  const name = path.basename(summary.test);
  const nothingHappened =
    summary.compiled === 0 && summary.keptAi === 0 && !summary.stoppedAt;
  // "Every step already has code-behind" is only true when the run reached
  // every step. Stopped with nothing generated, it is a lie — and the one the
  // author most needs not to be told, because it says the opposite of what
  // happened.
  if (nothingHappened && summary.notAttempted.length === 0) {
    return `✓ Nothing to compile in ${name} — every step already has code-behind.`;
  }
  if (nothingHappened) {
    return (
      `✗ Compiled nothing in ${name}: the run stopped before any step produced an entry ` +
      `(${summary.notAttempted.length} step(s) not attempted).`
    );
  }
  const parts = [`${summary.compiled} step(s) as code (unproven — the next run proves them)`];
  if (summary.keptAi > 0) parts.push(`${summary.keptAi} kept AI`);
  if (summary.stoppedAt) {
    parts.push(`stopped at step ${summary.stoppedAt.step} — ${summary.stoppedAt.error}`);
  }
  if (summary.notAttempted.length > 0) {
    parts.push(`${summary.notAttempted.length} step(s) not attempted`);
  }
  const glyph = event.status === 'green' ? '✓' : event.status === 'partial' ? '◐' : '✗';
  return `${glyph} Compiled ${name}: ${parts.join('; ')}.`;
}

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
    this.scopesByFrame.clear();
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
  handleFrameScope(frameId: string, scope: Record<string, string>): void {
    // Copy the payload — the SSE deserialiser shares the object across
    // listeners and mutating downstream would surprise others.
    this.scopesByFrame.set(frameId, { ...scope });
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
    opts?: { pauseAtNextTool?: boolean },
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
    // Also the disposal path: the registry tears controllers down by calling
    // stop() (see RunControllerRegistry.setApiClientFactory / dispose), so
    // this is where a paused run's keep-alive timer must be released.
    this.stopKeepAlive();
    this.active?.abort();
  }

  /** Post a run event to the webview AND notify any registered per-run
   *  event listener. Used by every code path that emits step:start /
   *  step:pass / step:fail / output / capture / done. */
  private emitRunEvent(event: RunEvent): void {
    this.post({ type: 'runEvent', event });
    this.currentEventListener?.(event);
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

  async closeSession(): Promise<void> {
    const out = getOutputChannel();
    const ts = () => new Date().toISOString().slice(11, 23);
    const resolved = await this.resolveClient();
    if (!resolved) return;
    out.appendLine(`[${ts()}] closing server session for ${resolved.sessionId}`);
    this.active?.abort();
    await resolved.client.closeSession(resolved.sessionId);
    this.configSentForSession = false;
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
      /** True when this call is a continuation of a breakpoint-paused run
       *  (i.e. Continue / Resume). Skips the status-clear that a fresh run
       *  performs so that pass marks from the first batch are preserved. The
       *  skill-file URIs revealed in the first batch are carried forward so
       *  the NEXT fresh re-run still cleans them up correctly. */
      isContinuation?: boolean;
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
       * (stories/compile-as-you-go.md). `'run'` is Run & Compile — the whole
       * test, Review at the end; `'steps'` is Compile This Step — the sent
       * steps only, code-behind execution off, no Review. The proposal comes
       * back on `RunOutcome.compile`; nothing is written until the caller
       * opens the diff and the author applies it.
       */
      compile?: 'run' | 'steps';
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

    // Clear any stale pause indicator IMMEDIATELY — synchronously, before
    // we do any async env-file work. If we waited until after env resolution
    // (~50-200ms on Windows), the user would see the yellow ▶ from the
    // previous pause linger at that line while the new run boots, which
    // reads as "the arrow jumped straight to the breakpoint."
    this.post({ type: 'breakpointStop', line: null });
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
      log(`.env.${effectiveEnvName} overlaid (${Object.keys(overlay).length} key(s))`);
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
    const sessionConfig: { baseUrl?: string; timeout?: string } = {};
    const baseUrl = rawConfig['baseUrl'];
    if (baseUrl) sessionConfig.baseUrl = resolveValue(baseUrl, env);
    const timeout = rawConfig['timeout'];
    if (timeout) sessionConfig.timeout = resolveValue(timeout, env);

    const logging = resolveLoggingOverride(rawConfig, settings);

    if (Object.keys(resolvedParameters).length > 0) {
      this.post({ type: 'parametersResolved', values: { ...resolvedParameters } });
    }

    log(
      `running ${classified.length} item(s) on ${serverUrl}` +
        (sessionConfig.baseUrl ? ` baseUrl=${sessionConfig.baseUrl}` : '') +
        (Object.keys(resolvedParameters).length > 0
          ? ` parameters=[${Object.keys(resolvedParameters).join(',')}]`
          : ''),
    );

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
     * Which compile mode this logical run is in.
     *
     * A Continue after a breakpoint is a separate `runLines` call with its own
     * options, and the author who pressed Run & Compile did not stop wanting a
     * compile when they hit a breakpoint — so a continuation inherits the mode
     * of the run it is continuing. Without this the rest of the test ran as a
     * plain Run and its entries were never generated.
     */
    const compileMode =
      options.compile ?? (options.isContinuation === true ? this.compileModeOfRun : undefined);
    if (options.isContinuation !== true) this.compileModeOfRun = options.compile;
    /** Step-blocks already sent in THIS call — the second onwards continues
     *  the compiler the first opened. */
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

    try {
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
            signal: ac.signal,
            log,
            ...(options.stepMode && { stepMode: options.stepMode }),
            ...(options.pauseAtNextTool && { pauseAtNextTool: true }),
            ...(pendingRerun && { rerun: pendingRerun }),
            ...(compileMode && { compile: compileMode }),
            // Blocks 2..n of this call, and every block of a Continue: the
            // compiler for this run is already open on the session.
            ...(compileMode && (compileBlocksSent > 0 || options.isContinuation === true) && {
              compileContinues: true,
            }),
          });
          compileBlocksSent++;
          pendingRerun = undefined;
          if (!ok) {
            anyFailed = true;
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
            break;
          }
          params[item.varName] = answer;
          this.postOutput(`✎ ${item.varName} ← ${maskIfSecret(item.varName, answer)}`, 'info');
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
          if (!exitedCleanly) break;
          i++;
          continue;
        }
      }

      this.configSentForSession = true;

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
      }
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
    sessionConfig: { baseUrl?: string; timeout?: string };
    logging?: LoggingOverride;
    signal: AbortSignal;
    log: (line: string) => void;
    /** Raw per-test `## Config: cache:` value (e.g. "on" / "off"), if the
     *  test declared one. Overrides the project's aiui.config.json
     *  `cache.enabled` for this run; see `resolveCacheOverride`. */
    cacheOverride?: string;
    /** Initial stepMode to send with the request body — when set, the
     *  server pauses between steps and the run is driven by `run-control`
     *  POSTs from the extension. */
    stepMode?: StepMode;
    /** Phase 5 — when true, the request body carries `pauseAtNextTool: true`.
     *  The server emits `tool:awaiting-debugger` before the next
     *  `[tool: ...]` step and parks for a debugger-attach ack. */
    pauseAtNextTool?: boolean;
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
  }): Promise<boolean> {
    const { block, client, sessionId, env, envName, params, sessionConfig, logging, signal, log, cacheOverride, stepMode, pauseAtNextTool, rerun, compile, compileContinues } = args;
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
    const sections = buildSectionsPayload(this.document.getText());

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
        // re-plans rather than replaying a frozen cached action list.
        ...(cacheEnabled && !rerun && { cacheEnabled: true }),
        testFilePath,
        ...(stepMode && { stepMode }),
        ...(pauseAtNextTool && { pauseAtNextTool: true }),
        ...(rerun && {
          startAt: rerun.startAt,
          ...(rerun.endAt && { endAt: rerun.endAt }),
          ...(rerun.seedScope && { seedScope: rerun.seedScope }),
        }),
        ...(this.breakpointsByUriProvider && (() => {
          const map = this.breakpointsByUriProvider!();
          return Object.keys(map).length > 0 ? { breakpointsByUri: map } : {};
        })()),
        ...(compile && { compile }),
        ...(compile && compileContinues && { compileContinues: true }),
      },
      signal,
    );

    let sawFail = false;
    let cachedCount = 0;
    let codeBehindCount = 0;
    let staleCount = 0;
    let passCount = 0;
    for await (const event of events) {
      this.configSentForSession = true;
      // The compile riding this run (stories/compile-as-you-go.md). Logged,
      // never folded into the gutter: by the time an entry is generated its
      // step has already painted ✓, and repainting ▶ on it would undo that.
      if (event.type === 'compile:step' || event.type === 'compile:result') {
        const line = compileLogLine(event);
        if (line !== null) log(line);
        if (event.type === 'compile:result') {
          this.compileResult = {
            ok: event.status !== 'failed',
            status: event.status,
            files: event.files,
            summary: event.summary,
            ...(event.status === 'failed' && {
              error: event.summary.error ?? 'the compile produced nothing',
            }),
          };
          this.post({ type: 'compileEvent', line: compileResultLine(event) });
          log(compileResultLine(event));
        }
        continue;
      }
      // How the step passed — the textual half of what the gutter glyphs say.
      // ⚡ replayed a recorded transcript, </> ran compiled code, ⚠ healed under
      // AI because the compiled entry threw.
      if (event.type === 'step:pass') {
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
      } else {
        log(`event ${event.type}${'line' in event ? ` line=${event.line}` : ''}`);
      }
      // Track the step that's currently executing — used as the resume
      // point if the user pauses mid-step.
      if (event.type === 'step:start') this.lastStepStartLine = event.line;
      if (event.type === 'step:fail') sawFail = true;
      if (event.type === 'done') {
        // Capture the report path so the "Open Last Report" surface can
        // resolve it later. Older servers omit this field — we leave
        // any previous value in place rather than clearing on every
        // run boundary, matching the spec's lifecycle rules.
        if (event.reportPath) this.lastResolvedReportPath = event.reportPath;
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
    if (passCount > 0) {
      const notes = [
        codeBehindCount > 0 ? `${codeBehindCount} code-behind` : '',
        staleCount > 0 ? `${staleCount} stale` : '',
        cachedCount > 0 ? `${cachedCount} cached` : '',
      ].filter((n) => n !== '');
      const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';
      log(`✓ ${passCount} passed${suffix}`);
      if (staleCount > 0) {
        log(`  ${staleCount} step(s) ran under AI because their code-behind failed — recompile.`);
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
    sessionConfig: { baseUrl?: string; timeout?: string };
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
            this.configSentForSession = true;
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
