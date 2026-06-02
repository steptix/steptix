import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  ApiClient,
  ApiClientError,
  EnvParseError,
  isUserAbort,
  classifySelectedSteps,
  extractSteps,
  resolveRunLines,
  interpretReplCommand,
  maskIfSecret,
  parseConfig,
  parseFrontmatter,
  parseParameters,
  readEnvFile,
  reportError,
  resolveEnvFile,
  resolveSection,
  type ClassifiedStep,
  type ErrorPayload,
  type FrameInfo,
  type HostToWebviewMsg,
  type RunEvent,
  type StepMode,
} from 'ai-ui-automation-runner-core';
import { getOutputChannel } from './output-channel.js';
import { EnvSelector } from './env-selector.js';
import { resolveProjectDirs } from './aiui-config.js';

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

/** Outcome reported back to callers — used by tests + commands. */
export interface RunOutcome {
  ok: boolean;
  error?: ErrorPayload;
}

/** Everything the "re-run this skill step with its variables" action needs,
 *  captured when a step inside a TOP-LEVEL skill fails. */
export interface SkillFailure {
  /** Server frame id of the failed (top-level) skill invocation. */
  frameId: string;
  /** Skill name, for the panel heading. */
  skillName: string;
  /** Absolute path of the skill file the failed step lives in. */
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
  /** Captured along with currentClient so the tool step-into feature can
   *  test whether the server is reachable as a Node debugger target.
   *  Cleared in the same finally block. */
  private currentServerUrl: string | null = null;

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
  ) {}

  get isRunning(): boolean {
    return this.active !== null;
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
   *  1-based line in the skill file. Called by the run-event router. */
  recordSkillFailure(frame: FrameInfo, failedLine: number): void {
    if (frame.parentId !== null) return; // v1: top-level skills only
    const root = this.frameRoot.get(frame.id);
    if (!root) return;
    this._lastSkillFailure = {
      frameId: frame.id,
      skillName: frame.skillName ?? 'skill',
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

  /**
   * True when the active run's server URL resolves to localhost
   * (127.0.0.1 / ::1 / localhost). Tool step-into requires this — the
   * VS Code Node debugger attaches to a local inspector socket, and we
   * can't reach a remote `--inspect` port. The extension uses this to
   * surface a clean "feature unavailable" error instead of attempting
   * the attach and failing opaquely.
   */
  isLocalServer(): boolean {
    if (!this.currentServerUrl) return false;
    try {
      const host = new URL(this.currentServerUrl).hostname.toLowerCase();
      return host === '127.0.0.1' || host === 'localhost' || host === '::1';
    } catch {
      return false;
    }
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
   * `sessionId` is the test file path — the server's session key. Shared by
   * `closeSession` and the re-run liveness probe.
   */
  private async resolveClient(): Promise<{ client: ApiClientLike; sessionId: string } | null> {
    const settings = vscode.workspace.getConfiguration('testbench-native');
    const fallbackSetting = settings.get<string>('defaultEnvFile') ?? '';
    const filePath = this.document.uri.fsPath;
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
    const apiKey = env['SERVER_API_KEY']?.trim();
    if (!serverUrl || !apiKey) return null;
    return { client: this.clientFactory({ serverUrl, apiKey }), sessionId: filePath };
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

  async runLines(
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
    } = {},
  ): Promise<RunOutcome> {
    if (this.isRunning) {
      return { ok: false };
    }

    // Clear any stale pause indicator IMMEDIATELY — synchronously, before
    // we do any async env-file work. If we waited until after env resolution
    // (~50-200ms on Windows), the user would see the yellow ▶ from the
    // previous pause linger at that line while the new run boots, which
    // reads as "the arrow jumped straight to the breakpoint."
    this.post({ type: 'breakpointStop', line: null });

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
    // Batch mode opts into forceFreshSession to give every test a clean
    // slate; that path bypasses the first-run-only gate.
    const forceFresh = options.forceFreshSession === true;
    if (forceFresh || !this.staleSessionCleared) {
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
    if (!env['SERVER_API_KEY'] || env['SERVER_API_KEY'].trim() === '') {
      const payload = reportError('TB003', { envPath: envResolution.path });
      return this.fail(payload, log);
    }
    const apiKey = env['SERVER_API_KEY'].trim();

    const text = this.document.getText();
    const effectiveLines = resolveRunLines(text, lines);
    const allClassified = classifySelectedSteps(text, effectiveLines);
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
      if (pausedAt !== null) this.post({ type: 'breakpointStop', line: pausedAt });
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

    const sessionId = filePath;
    const client = this.clientFactory({ serverUrl, apiKey });
    const ac = new AbortController();
    this.active = ac;
    // Monotonic run id — a background post-stop report poll (issue 021) uses it
    // to avoid clobbering a newer run's report path if one starts meanwhile.
    const myGeneration = ++this.runGeneration;
    this.pauseRequested = false;
    this.lastStepStartLine = null;
    // Capture so step-control commands (Phase 3) can target the same
    // session via the same client without rebuilding either.
    this.currentClient = client;
    this.currentSessionId = sessionId;
    this.currentServerUrl = serverUrl;

    // Resolve which env name to send to the server. Explicit override (batch
    // mode passes one per test) wins over the workspace-level EnvSelector.
    const effectiveEnvName =
      options.envOverride !== undefined ? options.envOverride : EnvSelector.activeEnv();

    const params: Record<string, string> = { ...resolvedParameters };
    let anyFailed = false;
    const batchMode = options.batchMode === true;

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
            ...(options.rerun && { rerun: options.rerun }),
          });
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
          const answer = await this.requestPrompt({
            mode: 'input',
            message: item.prompt,
            varName: item.varName,
          });
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
          const exitedCleanly = await this.runInteractive({
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
          });
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
        this.post({ type: 'breakpointStop', line: pausedAt });
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
          // Pause-at-top-level: fall back to the line of the most recent
          // step:start. If pause fired before any step:start (e.g. the
          // user hit Pause immediately after Run), fall back to the first
          // step in the run — without this, paused state is never set and
          // the Resume button doesn't render.
          const topFrame = this._frameStack[this._frameStack.length - 1];
          const root = topFrame ? this.frameRoot.get(topFrame.id) : undefined;
          const firstStepLine = classified.find((c) => c.kind === 'step')?.line ?? null;
          const resumeLine = root
            ? root.testLine
            : this.lastStepStartLine ?? firstStepLine;
          if (resumeLine != null) {
            this.post({ type: 'breakpointStop', line: resumeLine });
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
  }): Promise<boolean> {
    const { block, client, sessionId, env, envName, params, sessionConfig, logging, signal, log, cacheOverride, stepMode, pauseAtNextTool, rerun } = args;
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
      },
      signal,
    );

    let sawFail = false;
    let cachedCount = 0;
    let passCount = 0;
    for await (const event of events) {
      this.configSentForSession = true;
      // step:pass cache marker — user-visible signal that a step skipped
      // the AI call. The decoration ⚡ glyph is the in-editor signal; this
      // log line is the textual one for the Output channel.
      if (event.type === 'step:pass') {
        passCount += 1;
        if (event.fromCache) {
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
        continue;
      }
      this.emitRunEvent(event);
    }
    if (passCount > 0) {
      const suffix = cachedCount > 0 ? ` (${cachedCount} cached)` : '';
      log(`✓ ${passCount} passed${suffix}`);
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

function mapApiErrorToPayload(
  err: unknown,
  ctx: { serverUrl: string; envPath: string },
): ErrorPayload {
  if (err instanceof ApiClientError) {
    switch (err.kind) {
      case 'unauthorized':
        return reportError('TB011', { envPath: ctx.envPath, serverUrl: ctx.serverUrl });
      case 'not-found':
        return reportError('TB012', { serverUrl: ctx.serverUrl });
      case 'server-error':
        return reportError('TB013', {
          serverUrl: ctx.serverUrl,
          status: err.status ?? 0,
          ...(err.bodyExcerpt && { bodyExcerpt: err.bodyExcerpt }),
        });
      case 'stream-dropped':
        return reportError('TB014', { serverUrl: ctx.serverUrl, reason: err.message });
      case 'aborted':
        return reportError('TB014', { serverUrl: ctx.serverUrl, reason: 'aborted' });
      case 'connect-failed':
      default:
        return reportError('TB010', { serverUrl: ctx.serverUrl, reason: err.message });
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
