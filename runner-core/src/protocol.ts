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

export interface StepStartEvent {
  type: 'step:start';
  /** 1-based source line of the step in the original document. */
  line: number;
}

export interface StepPassEvent {
  type: 'step:pass';
  line: number;
  /** Optional captured output (e.g. AI explanation). */
  output?: string;
  /** data:image/png;base64 URI, may be empty. */
  screenshot?: string;
}

export interface StepFailEvent {
  type: 'step:fail';
  line: number;
  error: string;
  screenshot?: string;
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

export type RunEvent =
  | StepStartEvent
  | StepPassEvent
  | StepFailEvent
  | OutputEvent
  | CaptureEvent
  | DoneEvent;

// ---------------------------------------------------------------------------
// Host → webview
// ---------------------------------------------------------------------------

export interface HostEditorOptions {
  wordWrap?: 'off' | 'on' | 'wordWrapColumn' | 'bounded';
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontLigatures?: boolean | string;
  lineHeight?: number;
  letterSpacing?: number;
  cursorBlinking?: 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
  cursorSmoothCaretAnimation?: 'off' | 'explicit' | 'on';
  cursorStyle?: 'line' | 'block' | 'underline' | 'line-thin' | 'block-outline' | 'underline-thin';
  cursorWidth?: number;
  matchBrackets?: 'never' | 'near' | 'always';
  renderWhitespace?: 'none' | 'boundary' | 'selection' | 'trailing' | 'all';
  renderControlCharacters?: boolean;
  renderLineHighlight?: 'none' | 'gutter' | 'line' | 'all';
  renderLineHighlightOnlyWhenFocus?: boolean;
  selectionHighlight?: boolean;
  occurrencesHighlight?: 'off' | 'singleFile' | 'multiFile';
  bracketPairColorization?: {
    enabled?: boolean;
    independentColorPoolPerBracketType?: boolean;
  };
  guides?: {
    bracketPairs?: boolean | 'active';
    bracketPairsHorizontal?: boolean | 'active';
    highlightActiveBracketPair?: boolean;
    indentation?: boolean;
    highlightActiveIndentation?: boolean | 'always';
  };
  tabSize?: number;
  insertSpaces?: boolean;
  detectIndentation?: boolean;
  trimAutoWhitespace?: boolean;
}

export interface HostModelOptions {
  tabSize?: number;
  insertSpaces?: boolean;
  trimAutoWhitespace?: boolean;
  bracketColorizationOptions?: {
    enabled: boolean;
    independentColorPoolPerBracketType: boolean;
  };
}

export interface HostInitMsg {
  type: 'init';
  text: string;
  wordWrap: boolean;
  editorOptions?: HostEditorOptions;
  modelOptions?: HostModelOptions;
  /** Resolved absolute path of the test file, for display only. */
  filePath: string;
}

export interface HostDocumentChangedMsg {
  type: 'documentChanged';
  text: string;
}

export interface HostRunEventMsg {
  type: 'runEvent';
  event: RunEvent;
}

export interface HostRunErrorMsg {
  type: 'runError';
  payload: ErrorPayload;
}

export interface HostSettingsChangedMsg {
  type: 'settingsChanged';
  wordWrap: boolean;
  editorOptions?: HostEditorOptions;
  modelOptions?: HostModelOptions;
}

/**
 * Ask the user to type something. `mode: 'input'` is one-shot (filling a
 * `[input: var]` slot). `mode: 'interactive'` keeps the composer open
 * across submissions until the host posts `promptDone`.
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

export type HostToWebviewMsg =
  | HostInitMsg
  | HostDocumentChangedMsg
  | HostRunEventMsg
  | HostRunErrorMsg
  | HostSettingsChangedMsg
  | HostPromptMsg
  | HostPromptDoneMsg
  | HostParametersResolvedMsg;

// ---------------------------------------------------------------------------
// Webview → host
// ---------------------------------------------------------------------------

export interface WebviewReadyMsg {
  type: 'ready';
}

export interface WebviewRunMsg {
  type: 'run';
  /** 1-based line numbers to run. Empty array runs nothing. */
  lines: number[];
}

export interface WebviewRunAllMsg {
  type: 'runAll';
}

export interface WebviewStopMsg {
  type: 'stop';
}

export interface WebviewEditMsg {
  type: 'edit';
  text: string;
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

export type WebviewToHostMsg =
  | WebviewReadyMsg
  | WebviewRunMsg
  | WebviewRunAllMsg
  | WebviewStopMsg
  | WebviewEditMsg
  | WebviewRestartSessionMsg
  | WebviewPromptResponseMsg
  | WebviewPromptCancelMsg;

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

export function isHostMsg(value: unknown): value is HostToWebviewMsg {
  if (!value || typeof value !== 'object') return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === 'init' ||
    t === 'documentChanged' ||
    t === 'runEvent' ||
    t === 'runError' ||
    t === 'settingsChanged' ||
    t === 'prompt' ||
    t === 'promptDone' ||
    t === 'parametersResolved'
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
    t === 'edit' ||
    t === 'restartSession' ||
    t === 'promptResponse' ||
    t === 'promptCancel'
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
    t === 'done'
  );
}
