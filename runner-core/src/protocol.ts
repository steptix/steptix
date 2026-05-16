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
 * A frame is one execution scope: the top-level test, or a `[skill: ...]`
 * invocation. Frames nest when skills call skills. `id` is unique per run
 * and stable for the lifetime of the frame; `parentId` is null for the
 * test frame and the parent's id otherwise.
 */
export interface FrameInfo {
  id: string;
  parentId: string | null;
  kind: 'test' | 'skill';
  /** Absolute path (file:// URI form) of the file this frame's steps live in. */
  uri: string;
  /** 1-based line of the step in that file. */
  line: number;
  /** Set when `kind === 'skill'` — the skill name as authored. */
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
}

export interface DoneEvent {
  type: 'done';
  status: RunStatus;
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
  | StepAwaitingEvent;

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
  statuses: Array<[number, 'running' | 'pass' | 'fail' | 'skip' | 'stopped']>;
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

export type HostToWebviewMsg =
  | HostActiveFileMsg
  | HostRunEventMsg
  | HostRunErrorMsg
  | HostPromptMsg
  | HostPromptDoneMsg
  | HostParametersResolvedMsg
  | HostRunningMsg
  | HostBreakpointStopMsg
  | HostBatchBannerMsg;

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

export type WebviewToHostMsg =
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
  | WebviewClearStatusMsg;

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
    t === 'batchBanner'
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
    t === 'clearStatus'
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
    t === 'step:awaiting'
  );
}
