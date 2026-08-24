/**
 * Typed message protocol between the extension host and the webview.
 *
 * Both directions are exhaustive discriminated unions. Use the narrowing
 * helpers below at message-handler boundaries — never compare `type`
 * strings inline.
 */

import type { ErrorPayload } from './errors.js';

// ---------------------------------------------------------------------------
// Server-side run events (mirrored from SSE)
// ---------------------------------------------------------------------------

export type RunStatus = 'passed' | 'failed' | 'error' | 'aborted';
export type StepStatus = 'passed' | 'failed' | 'error';

/**
 * Origin frame for a step event. Present from servers that support the
 * step-into protocol (added in Phase 1 of the step-into work). Absent on
 * legacy servers — clients must tolerate missing `frame`.
 *
 * A frame is one execution scope: the top-level test, a `[skill: ...]`
 * invocation, or an inline `### Section` call. Frames nest when skills call
 * skills, when a section calls a section, and in either combination. `id` is
 * unique per run and stable for the lifetime of the frame; `parentId` is null
 * for the test frame and the parent's id otherwise.
 */
export interface FrameInfo {
  id: string;
  parentId: string | null;
  kind: 'test' | 'skill' | 'section';
  /**
   * Absolute path (file:// URI form) of the file this frame's steps live in.
   * For `kind === 'section'` that is the file that **defines** the section:
   * the test file for a test-file section, the skill file for one declared
   * inside a skill body.
   */
  uri: string;
  /** 1-based line of the step in that file. */
  line: number;
  /**
   * Set when `kind === 'skill'` — the skill name as authored — and when
   * `kind === 'section'`, where it carries the **section** name. For a
   * section declared inside a skill, the enclosing skill's name is on the
   * nearest ancestor frame with `kind === 'skill'`, not here.
   */
  skillName?: string;
}

export interface StepStartEvent {
  type: 'step:start';
  /** 1-based source line of the step in the original document. */
  line: number;
  /** Origin frame the step belongs to. Optional for backward compat. */
  frame?: FrameInfo;
}

export interface StepPassEvent {
  type: 'step:pass';
  line: number;
  /** Optional captured output (e.g. AI explanation). */
  output?: string;
  /** data:image/png;base64 URI, may be empty. */
  screenshot?: string;
  frame?: FrameInfo;
  /** True when every AI turn for this step was served from `StepCache` —
   *  no AI call was made. Absent / false means the AI was called. The
   *  client uses this to paint a ⚡ glyph instead of the standard ✓ and
   *  to mark the run-log line as `(cached)`. */
  fromCache?: boolean;
  /**
   * True when the step ran its code-behind entry instead of calling the AI
   * (stories/codebehind-compile.md §What the author sees). Painted with the code mark, logged
   * `(code-behind)`. Distinct from `fromCache`: that one replays a recorded AI
   * transcript, this one runs TypeScript the author can read.
   */
  fromCodeBehind?: boolean;
  /**
   * Present when the step's entry threw and the step then passed under AI.
   * Painted ⚠ — "ran under AI; recompile" — and `file` is what Open
   * Code-behind opens. On a pass event because the STEP passed; it is the
   * entry that failed.
   */
  codeBehindStale?: { file: string; error: string };
}

export interface StepFailEvent {
  type: 'step:fail';
  line: number;
  error: string;
  screenshot?: string;
  frame?: FrameInfo;
}

/**
 * Emitted when execution enters a new frame — i.e. just before the first
 * step of a `[skill: ...]` invocation runs. Pairs 1:1 with a `frame:pop`.
 */
export interface FramePushEvent {
  type: 'frame:push';
  frame: FrameInfo;
}

/**
 * Emitted when a frame finishes (its last step passed, or execution fell
 * off the end of the skill body). `outputs` carries the values the skill
 * exposed back to the caller — aliased into the caller's variable scope.
 */
export interface FramePopEvent {
  type: 'frame:pop';
  frameId: string;
  outputs: Record<string, string>;
}

/**
 * Snapshot of the variable scope visible inside a frame at a step boundary.
 * Used by the Variables panel (Phase 4) — Phase 1 servers may emit these
 * sparsely or not at all; clients must treat the type as informational.
 */
export interface FrameScopeEvent {
  type: 'frame:scope';
  frameId: string;
  scope: Record<string, string>;
}

export interface OutputEvent {
  type: 'output';
  msg: string;
  kind: 'info' | 'warn' | 'error';
}

/**
 * Emitted whenever an `[output: var]` step extracts a value. Lets the
 * webview update the Variables panel live as captures happen.
 */
export interface CaptureEvent {
  type: 'capture';
  line: number;
  name: string;
  value: string;
  /**
   * Where this variable came from. Only `'capture'` (an `[output:]`/`[store
   * as:]` extraction) and `'toolOutput'` (a `[tool:]`/`[skill:]` return)
   * flow through this event — `'parameter'` values arrive via the separate
   * `parametersResolved` event, which already tags them by event type, so it
   * is intentionally absent here. Required on new emitters; consumers talking
   * to a not-yet-upgraded server must treat an absent `source` as
   * `'capture'` (the conservative default).
   */
  source: 'capture' | 'toolOutput';
}

export interface DoneEvent {
  type: 'done';
  status: RunStatus;
  /** Absolute path of the HTML report written by the server when report
   *  generation succeeded. Omitted when the run produced no step results
   *  or `generateReport` threw. Clients use this to surface an "Open
   *  Report" button after the run finishes. Backward-compatible: older
   *  servers omit the field, older clients ignore it. */
  reportPath?: string;
}

/**
 * Step-mode controls available on requests and resume commands. The runner
 * uses these to decide whether to pause between steps, and at what depth:
 *
 *  - `continue` — run to the next breakpoint or end-of-batch. No
 *    between-step pauses.
 *  - `into` — pause unconditionally after each emitted step. Stepping
 *    "into" a `[skill: ...]` happens naturally: the next step the server
 *    pauses on is the first step of the skill body.
 *  - `over` — pause when the next step is at or shallower than the
 *    just-executed step's frame depth. Skips the entire body of any
 *    deeper skill invocation as a single atomic step.
 *  - `out` — pause when the next step is strictly shallower than the
 *    just-executed step's frame depth. Runs to the end of the current
 *    frame. No-op at the test (root) frame.
 */
export type StepMode = 'continue' | 'into' | 'over' | 'out';

/**
 * Emitted by step-mode-aware servers when they reach a pause point
 * between steps. `line` and `frame` point at the next step that will
 * execute when the client sends the next run-control command. Acts as
 * the "yellow ▶" signal for the step-into UI; mirrors how
 * `breakpointStop` signals the pause at a breakpoint hit.
 *
 * Servers that don't support stepMode never emit this; legacy clients
 * that don't read it stay on the existing breakpoint-only pause story.
 */
export interface StepAwaitingEvent {
  type: 'step:awaiting';
  line: number;
  frame?: FrameInfo;
}

/**
 * Emitted right before the server hits its `debugger;` pause at the tool
 * dispatcher's call site (Phase 5 — tool step-into). The client takes this
 * as its cue to attach VS Code's Node debugger to the server process and
 * then POST `/sessions/:id/tool-debugger-ack` so the server proceeds.
 *
 * Only fires when the client opted into tool step-into via
 * `pauseAtNextTool` on the next-run-control. Servers that don't support
 * tool step-into never emit this; clients that don't read it stay on the
 * existing pause-between-steps story.
 */
export interface ToolAwaitingDebuggerEvent {
  type: 'tool:awaiting-debugger';
  /** The tool name as authored on the `[tool: ...]` line. */
  toolName: string;
  /** Absolute path to the tool's source file (`.ts` from the catalogue's
   *  `RegisteredTool.filePath`). The extension uses this to scope the
   *  Node debugger's source-map handling and to surface "we're stepping
   *  into <file>" in the UI overlay. */
  toolFilePath?: string;
  /** 1-based source line of the `[tool: ...]` invocation in the test/skill
   *  file. The yellow ▶ stays parked on this line while VS Code's Node
   *  debugger drives the user inside the tool body. */
  line: number;
  /** Origin frame the tool call belongs to. */
  frame?: FrameInfo;
}

export type RunEvent =
  | StepStartEvent
  | StepPassEvent
  | StepFailEvent
  | OutputEvent
  | CaptureEvent
  | DoneEvent
  | FramePushEvent
  | FramePopEvent
  | FrameScopeEvent
  | StepAwaitingEvent
  | ToolAwaitingDebuggerEvent
  // A compile-mode run's own frames (stories/compile-as-you-go.md §On the
  // wire). Deliberately the SAME shapes the compile stream carries, so a
  // client's folding code works on either stream: `compile:step` as each
  // entry is generated or declined, `compile:result` once, terminal, just
  // before `done`. Absent from an ordinary run, which sends no `compile`.
  | CompileStepEvent
  | CompileResultEvent;

// ---------------------------------------------------------------------------
// Compile stream (stories/codebehind-compile.md §Server)
// ---------------------------------------------------------------------------

/**
 * The compile pipeline's phases, in order.
 *
 * Mirrors `CompilePhase` in the framework's `src/codebehind/compile.ts`. Named
 * again here because `runner-core` is the wire contract and must not import
 * from the server it talks to.
 */
export type CompilePhase =
  | 'record'
  | 'select'
  | 'generate'
  | 'review'
  | 'replay'
  | 'repair'
  | 'write';

/**
 * `partial` (stories/codebehind-compile-as-a-run.md §Write what passed): the
 * compile proposes what it has — proven entries, write-offs, entries no round
 * reached — and the summary says which is which. `failed` proposes nothing.
 */
export type CompileStatus = 'green' | 'partial' | 'failed';

/** A phase started, or reported its result. */
export interface CompilePhaseEvent {
  type: 'compile:phase';
  phase: CompilePhase;
  /** 1-based replay round, when the phase repeats. */
  round?: number;
  message: string;
}

/** Something happened to one step, 1-based. */
export interface CompileStepEvent {
  type: 'compile:step';
  phase: CompilePhase;
  step: number;
  /** The step's source line in the test file, when the server knows it —
   *  paint ▶ there while the model works on the step. */
  line?: number;
  message: string;
}

/**
 * One event of a run the compile drove — Record, or a Replay round — untouched
 * inside the wrapper (stories/codebehind-compile-as-a-run.md §Every run is on
 * the stream). A client folds `event` as it folds a run's own: ▶ on
 * `step:start`, the code mark on a `step:pass` with `fromCodeBehind`, ✗ with the error
 * and screenshot on `step:fail`.
 */
export interface CompileRunEvent {
  type: 'compile:run';
  phase: 'record' | 'replay';
  /** 1-based replay round. */
  round?: number;
  event: RunEvent;
}

/** Terminal narrative event. The result follows separately. */
export interface CompileDoneEvent {
  type: 'compile:done';
  status: CompileStatus;
  message: string;
}

export interface CompileSummary {
  /** Absolute path of the test file. */
  test: string;
  totalSteps: number;
  /** Steps whose entries this pass generated. */
  compiled: number;
  /** Steps whose existing entries were kept verbatim. */
  kept: number;
  /** Steps that stay AI — existing `ai: true` entries plus new declines. */
  keptAi: number;
  rounds: number;
  tokensUsed: number;
  /** Absolute paths written. Always empty from the server, which never writes
   *  under the project — the client applies. */
  written: string[];
  /** Where the candidate was left when nothing was written. */
  candidatePath?: string;
  /** Why the compile is not green. */
  error?: string;
  /** Steps (1-based) whose new entries no replay round executed to a pass.
   *  Proposed as code all the same; the next run proves or flags them. */
  unproven: number[];
  /** Steps (1-based) written off as `ai: true` after a replay failure. */
  writtenOffAi: number[];
  /** Where the recording stopped, when it did not reach the end of the test —
   *  the compile was then a prefix compile of the steps before it. */
  stoppedAt?: { step: number; error: string };
  /** Selected steps the prefix never reached; nothing was generated for them. */
  notAttempted: number[];
  /** Where the recording, the candidate and any replay failure were written —
   *  the test's `.aiui-codebehind-cache/<name>.recording/`
   *  (stories/codebehind-recording-on-disk.md). */
  recordingDir: string;
}

/**
 * The last frame of a compile stream: what to diff, and what to say about it.
 *
 * `files` is the whole proposed content of each `.steps.ts`, not a patch — the
 * client renders it as the right-hand side of a diff and writes it on Apply.
 * Several files when the test invokes skills, whose entries compile into the
 * skill's own file.
 */
export interface CompileResultEvent {
  type: 'compile:result';
  status: CompileStatus;
  files: Record<string, string>;
  summary: CompileSummary;
}

export type CompileEvent =
  | CompilePhaseEvent
  | CompileStepEvent
  | CompileDoneEvent
  | CompileResultEvent
  | CompileRunEvent
  | OutputEvent;

export function isCompileEvent(value: unknown): value is CompileEvent {
  if (!value || typeof value !== 'object') return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === 'compile:phase' ||
    t === 'compile:step' ||
    t === 'compile:done' ||
    t === 'compile:result' ||
    (t === 'compile:run' && isRunEvent((value as { event?: unknown }).event)) ||
    t === 'output'
  );
}

/** `POST /codebehind/compile` (stories/codebehind-compile.md §Server). */
export interface CompileRequest {
  /** Absolute path of the test file to compile. */
  testFilePath: string;
  /** The editor's steps, for the server's saved-file guard. */
  steps?: string[];
  sections?: Record<string, { name: string; headingLine: number; steps: string[]; stepLines: number[] }>;
  envName?: string;
  /**
   * The caller's session — the one this test runs in. Record runs in it and
   * leaves it open, as a Run would; every compile records, to disk beside the
   * test (stories/codebehind-recording-on-disk.md).
   */
  sessionId?: string;
  select?: { onlyStale?: boolean; all?: boolean; steps?: number[] };
  maxRounds?: number;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Per-document state snapshot (sent host → webview)
// ---------------------------------------------------------------------------

/**
 * Mirror of the active TextEditor's TestBench state: file text, breakpoints,
 * statuses, paused-at marker. The webview renders against this; the host is
 * the source of truth.
 */
export interface FileStateSnapshot {
  uri: string | null;
  filePath: string | null;
  isTestFile: boolean;
  text: string;
  breakpoints: number[];
  statuses: Array<
    [
      number,
      | 'running'
      | 'pass'
      | 'pass-cached'
      /** Passed by running its code-behind entry — the `</>` code mark. */
      | 'pass-code-behind'
      /** Passed under AI after its entry threw — ⚠, recompile. */
      | 'pass-stale'
      | 'fail'
      | 'skip'
      | 'stopped',
    ]
  >;
  errors: Array<[number, ErrorPayload]>;
  breakpointStop: number | null;
  selectedLines: number[];
  cursorLine: number;
}

// ---------------------------------------------------------------------------
// Host → webview
// ---------------------------------------------------------------------------

/**
 * Whenever the active TextEditor changes, or the breakpoint/status/cursor
 * state on the active file changes, the host posts a fresh snapshot. The
 * webview re-renders against it.
 */
export interface HostActiveFileMsg {
  type: 'activeFile';
  snapshot: FileStateSnapshot;
}

export interface HostRunEventMsg {
  type: 'runEvent';
  event: RunEvent;
}

export interface HostRunErrorMsg {
  type: 'runError';
  payload: ErrorPayload;
}

/**
 * Ask the user to type something. `mode: 'input'` is one-shot (filling a
 * `[input: var]` slot) and is now handled host-side via showInputBox. The
 * webview only sees `mode: 'interactive'` for the multi-turn REPL composer.
 */
export interface HostPromptMsg {
  type: 'prompt';
  mode: 'input' | 'interactive';
  message: string;
  /** For mode === 'input', the {{var}} this answer fills. */
  varName?: string;
}

/** Tell the webview to hide its composer — the prompt cycle is over. */
export interface HostPromptDoneMsg {
  type: 'promptDone';
}

/**
 * Resolved `## Parameters` map. Sent at run start once the host has loaded
 * .env and substituted `$VAR` references — lets the Variables panel show
 * real values instead of the raw `$VAR` placeholders the webview parsed
 * from the source. Secret-named entries (password / token / apikey...)
 * are still masked at render time by the existing maskIfSecret helper.
 */
export interface HostParametersResolvedMsg {
  type: 'parametersResolved';
  values: Record<string, string>;
}

/** True while a run is in flight; lets the webview enable/disable buttons. */
export interface HostRunningMsg {
  type: 'running';
  running: boolean;
}

/**
 * Mark the line where a run paused at a breakpoint. `null` clears the
 * pause indicator. The webview/decorations show a yellow ▶ glyph on the
 * paused line.
 */
export interface HostBreakpointStopMsg {
  type: 'breakpointStop';
  line: number | null;
  /**
   * Set only when `line` is a section-body line **and** the host knows how to
   * resume from it — i.e. it also knows the invocation that body is running
   * under (`callLine`), or knows there isn't one because the body was run
   * detached (`callLine: null`).
   *
   * Its absence on a body line is meaningful, not a default: it marks a
   * marker we cannot resume — one left behind by a dropped stream or a
   * restarted server — which Continue must refuse rather than guess at. See
   * testbench-native/stories/specs/sections-run-and-resume.md §5.1.
   *
   * The webview ignores this field; only the tracker reads it.
   */
  resumeContext?: { kind: 'section-body'; callLine: number | null };
}

/**
 * Surface multi-test batch run progress in the sidebar webview. The webview
 * renders a banner at the top while `state` is non-null and clears it on
 * `null`. The Test Explorer's progress UI is still the primary surface;
 * this banner exists so users staring at the TestBench sidebar know a
 * batch is in flight and don't try to drive runs from this panel.
 */
export interface HostBatchBannerMsg {
  type: 'batchBanner';
  state: { running: number; total: number } | null;
}

/**
 * Offer (or withdraw) the "re-run this skill step with its variables" action
 * in the Variables panel. Sent with a non-null `failure` when a step inside a
 * top-level skill fails and its session is still live; the webview shows the
 * captured scope with editable capture rows and a "Re-run from failed step"
 * button. `failure: null` withdraws it. The webview also withdraws it on the
 * next `running: true` (a new run invalidates the parked failure's scope).
 */
export interface HostSkillRerunAvailableMsg {
  type: 'skillRerunAvailable';
  failure: {
    /** Owning test document URI (as a string). Echoed back in the re-run
     *  message so the host targets THIS test's controller — critical when two
     *  tests share a skill and both have a parked failure. */
    testUri: string;
    /** Skill name, for the panel heading. */
    skillName: string;
    /** Captured scope to seed, already stripped of `__skill*` internals. */
    scope: Record<string, string>;
    /** Names within `scope` that are the skill's input parameters — read-only
     *  in v1 (baked into step text at expansion). Everything else is an
     *  editable captured/runtime var. */
    paramNames: string[];
  } | null;
}

/**
 * A compile is running, or has stopped (stories/codebehind-compile.md §What
 * the author sees). The panel shows the phase lines while `running`, and
 * disables Compile so a second one cannot be started against the same file —
 * the server would refuse it anyway.
 */
export interface HostCompileStateMsg {
  type: 'compileState';
  running: boolean;
  /** Absolute path of the test being compiled. Present on start. */
  file?: string;
}

/** One already-formatted compile log line, for the panel to append. */
export interface HostCompileEventMsg {
  type: 'compileEvent';
  line: string;
}

/**
 * One event of a run the compile drove — the Record, or a Replay round —
 * forwarded for the panel's Variables section (captures) and mirrored to the
 * gutter by the host (stories/codebehind-compile-as-a-run.md §Every run is on
 * the stream). The log line for it arrives separately as `compileEvent`, so
 * the panel does not log this one.
 */
export interface HostCompileRunEventMsg {
  type: 'compileRunEvent';
  phase: 'record' | 'replay';
  round?: number;
  event: RunEvent;
}

/**
 * The model is working on the step at `line` (Generate or Repair). The host
 * paints ▶ there, so the gutter walks the test during the phases that do not
 * execute it.
 */
export interface HostCompileStepMsg {
  type: 'compileStep';
  line: number;
}

export type HostToWebviewMsg =
  | HostActiveFileMsg
  | HostRunEventMsg
  | HostRunErrorMsg
  | HostPromptMsg
  | HostPromptDoneMsg
  | HostParametersResolvedMsg
  | HostRunningMsg
  | HostBreakpointStopMsg
  | HostBatchBannerMsg
  | HostSkillRerunAvailableMsg
  | HostCompileStateMsg
  | HostCompileEventMsg
  | HostCompileRunEventMsg
  | HostCompileStepMsg;

// ---------------------------------------------------------------------------
// Webview → host
// ---------------------------------------------------------------------------

export interface WebviewReadyMsg {
  type: 'ready';
}

export interface WebviewRunMsg {
  type: 'run';
  /**
   * 1-based line numbers to run. Empty array runs everything from the
   * cursor onwards (the host expands as needed).
   */
  lines: number[];
}

export interface WebviewRunAllMsg {
  type: 'runAll';
}

export interface WebviewStopMsg {
  type: 'stop';
}

export interface WebviewRestartSessionMsg {
  type: 'restartSession';
}

/** User submitted text into the composer. Newlines preserved as-is. */
export interface WebviewPromptResponseMsg {
  type: 'promptResponse';
  text: string;
}

/** User clicked Cancel (or hit Stop while a prompt was open). */
export interface WebviewPromptCancelMsg {
  type: 'promptCancel';
}

/** User clicked a line in the sidebar's step list — focus the active editor. */
export interface WebviewRevealLineMsg {
  type: 'revealLine';
  line: number;
}

/** User clicked the breakpoint dot in the sidebar — toggle on the active file. */
export interface WebviewToggleBreakpointMsg {
  type: 'toggleBreakpoint';
  line: number;
}

/** User clicked Resume — re-run from the breakpoint pause line. */
export interface WebviewResumeMsg {
  type: 'resume';
}

/** User clicked Pause — abort current stream, mark resume point. */
export interface WebviewPauseMsg {
  type: 'pause';
}

/**
 * User clicked the batch-banner's "Open Test Results" link. Host
 * forwards to the built-in `workbench.panel.testResults.focus` command.
 * A dedicated message rather than arbitrary command execution keeps the
 * webview → host surface narrow.
 */
export interface WebviewFocusTestResultsMsg {
  type: 'focusTestResults';
}

/**
 * User picked "Clear status here" on a step's context menu. Drops the
 * pass/fail status and any error attached to that single line — the
 * file-wide `testbench.clearStatuses` command remains for clearing all.
 */
export interface WebviewClearStatusMsg {
  type: 'clearStatus';
  line: number;
}

/**
 * Diagnostic readback from the webview to the host. The webview posts
 * this whenever its internal `runtimeVariables` map changes (i.e. when
 * a `frame:scope` / `capture` / `parametersResolved` event updates it).
 * Used only by the test hooks — production code reads the same state
 * from the controller's per-frame scope map. Posted unconditionally so
 * a test harness doesn't have to drive the webview's request/response
 * cycle.
 */
export interface WebviewStateMsg {
  type: 'webviewState';
  runtimeVariables: Record<string, string>;
}

/**
 * User clicked "Re-run from failed step" in the Variables panel. `edits` are
 * the (caller-visible) captured-var values the user changed; the host overlays
 * them on the captured scope and re-runs the failed skill from the failed step
 * to the end of the skill on the live session. Param / `__skill*` names are
 * never included (params are read-only in v1; internals aren't editable).
 */
export interface WebviewRerunSkillStepMsg {
  type: 'rerunSkillStep';
  /** Owning test document URI (echoed from `skillRerunAvailable`) so the host
   *  re-runs the right test when more than one has a parked failure. */
  testUri: string;
  edits: Record<string, string>;
}

/**
 * User pressed Compile in the runner panel. The host always compiles against
 * the document's own session — from its last run when that can be the
 * recording, recording in it otherwise (stories/codebehind-compile-as-a-run.md).
 */
export interface WebviewCompileMsg {
  type: 'compile';
}

export type WebviewToHostMsg =
  | WebviewCompileMsg
  | WebviewReadyMsg
  | WebviewRunMsg
  | WebviewRunAllMsg
  | WebviewStopMsg
  | WebviewRestartSessionMsg
  | WebviewPromptResponseMsg
  | WebviewPromptCancelMsg
  | WebviewRevealLineMsg
  | WebviewToggleBreakpointMsg
  | WebviewResumeMsg
  | WebviewPauseMsg
  | WebviewFocusTestResultsMsg
  | WebviewClearStatusMsg
  | WebviewStateMsg
  | WebviewRerunSkillStepMsg;

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

export function isHostMsg(value: unknown): value is HostToWebviewMsg {
  if (!value || typeof value !== 'object') return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === 'activeFile' ||
    t === 'runEvent' ||
    t === 'runError' ||
    t === 'prompt' ||
    t === 'promptDone' ||
    t === 'parametersResolved' ||
    t === 'running' ||
    t === 'breakpointStop' ||
    t === 'batchBanner' ||
    t === 'skillRerunAvailable' ||
    t === 'compileState' ||
    t === 'compileEvent' ||
    t === 'compileRunEvent' ||
    t === 'compileStep'
  );
}

export function isWebviewMsg(value: unknown): value is WebviewToHostMsg {
  if (!value || typeof value !== 'object') return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === 'ready' ||
    t === 'run' ||
    t === 'runAll' ||
    t === 'stop' ||
    t === 'restartSession' ||
    t === 'promptResponse' ||
    t === 'promptCancel' ||
    t === 'revealLine' ||
    t === 'toggleBreakpoint' ||
    t === 'resume' ||
    t === 'pause' ||
    t === 'focusTestResults' ||
    t === 'clearStatus' ||
    t === 'webviewState' ||
    t === 'rerunSkillStep' ||
    t === 'compile'
  );
}

export function isRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== 'object') return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === 'step:start' ||
    t === 'step:pass' ||
    t === 'step:fail' ||
    t === 'output' ||
    t === 'capture' ||
    t === 'done' ||
    t === 'frame:push' ||
    t === 'frame:pop' ||
    t === 'frame:scope' ||
    t === 'step:awaiting' ||
    t === 'tool:awaiting-debugger' ||
    // Only a compile-mode run emits these; an ordinary one never does.
    t === 'compile:step' ||
    t === 'compile:result'
  );
}
