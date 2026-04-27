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

export interface DoneEvent {
  type: 'done';
  status: RunStatus;
}

export type RunEvent = StepStartEvent | StepPassEvent | StepFailEvent | OutputEvent | DoneEvent;

// ---------------------------------------------------------------------------
// Host → webview
// ---------------------------------------------------------------------------

export interface HostInitMsg {
  type: 'init';
  text: string;
  wordWrap: boolean;
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
}

export type HostToWebviewMsg =
  | HostInitMsg
  | HostDocumentChangedMsg
  | HostRunEventMsg
  | HostRunErrorMsg
  | HostSettingsChangedMsg;

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

export type WebviewToHostMsg =
  | WebviewReadyMsg
  | WebviewRunMsg
  | WebviewRunAllMsg
  | WebviewStopMsg
  | WebviewEditMsg;

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
    t === 'settingsChanged'
  );
}

export function isWebviewMsg(value: unknown): value is WebviewToHostMsg {
  if (!value || typeof value !== 'object') return false;
  const t = (value as { type?: unknown }).type;
  return t === 'ready' || t === 'run' || t === 'runAll' || t === 'stop' || t === 'edit';
}

export function isRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== 'object') return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === 'step:start' ||
    t === 'step:pass' ||
    t === 'step:fail' ||
    t === 'output' ||
    t === 'done'
  );
}
