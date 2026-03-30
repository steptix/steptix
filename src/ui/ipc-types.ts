/**
 * Shared IPC type definitions used by both the Electron main process and
 * the renderer (React) process. This is the only module imported by both sides.
 *
 * When porting to a web app the IPC channel names become WebSocket event names.
 */

// ---------------------------------------------------------------------------
// Re-export existing report types that the renderer needs
// ---------------------------------------------------------------------------
import type { SubActionResult as _SubActionResult, StepResult as _StepResult, AiInteraction as _AiInteraction } from '../report/types.js';

export type SubActionResult = _SubActionResult;
export type StepResult = _StepResult;
export type AiInteraction = _AiInteraction;

// ---------------------------------------------------------------------------
// Run state model (renderer-side)
// ---------------------------------------------------------------------------
export type PauseReason = 'breakpoint' | 'interactive' | 'input' | 'stepover';

export type RunStatus = 'idle' | 'running' | 'paused' | 'complete';

export type RunState =
  | { status: 'idle' }
  | { status: 'running'; currentStep: number }
  | { status: 'paused'; currentStep: number; reason: PauseReason }
  | { status: 'complete'; result: 'passed' | 'failed' };

export interface StepOutput {
  stepIndex: number;
  instruction: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  aiReasoning: string;
  aiInteractions: AiInteraction[];
  subActions: SubActionResult[];
  screenshots: string[]; // base64 data URLs
  domSnapshot?: string;
  error?: string;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------
export interface FileTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeEntry[];
}

// ---------------------------------------------------------------------------
// Main → Renderer events
// ---------------------------------------------------------------------------
export interface MainToRendererEvents {
  'runner:step-start': {
    stepIndex: number;
    instruction: string;
    totalSteps: number;
  };
  'runner:step-complete': {
    stepIndex: number;
    status: 'passed' | 'failed';
    durationMs: number;
    error?: string;
  };
  'runner:subaction': {
    stepIndex: number;
    subAction: SubActionResult;
  };
  'runner:screenshot': {
    stepIndex: number;
    dataUrl: string;
  };
  'runner:ai-reasoning': {
    stepIndex: number;
    text: string;
  };
  'runner:ai-interactions': {
    stepIndex: number;
    aiInteractions: AiInteraction[];
    domSnapshot?: string;
  };
  'runner:paused': {
    stepIndex: number;
    reason: PauseReason;
    /** For [input:] steps, the prompt text + variable name */
    inputPrompt?: string;
    inputVariable?: string;
  };
  'runner:resumed': Record<string, never>;
  'runner:complete': {
    status: 'passed' | 'failed';
    reportPath?: string;
  };
  'runner:error': {
    message: string;
  };
  'runner:log': {
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
  };
  'file:changed': {
    path: string;
    content?: string;
  };
}

// ---------------------------------------------------------------------------
// Renderer → Main events (invoke = request/response, send = fire-and-forget)
// ---------------------------------------------------------------------------
export interface RendererToMainInvokes {
  'runner:start': {
    params: { filePath: string; breakpoints: number[] };
    result: void;
  };
  'runner:stop': {
    params: Record<string, never>;
    result: void;
  };
  'runner:resume': {
    params: Record<string, never>;
    result: void;
  };
  'runner:step-over': {
    params: Record<string, never>;
    result: void;
  };
  'runner:move-pointer': {
    params: { toStepIndex: number };
    result: void;
  };
  'runner:steer': {
    params: { instruction: string };
    result: void;
  };
  'runner:input-response': {
    params: { variable: string; value: string };
    result: void;
  };
  'runner:update-breakpoints': {
    params: { breakpoints: number[] };
    result: void;
  };
  'file:read': {
    params: { path: string };
    result: { content: string };
  };
  'file:write': {
    params: { path: string; content: string };
    result: void;
  };
  'file:list': {
    params: { dir: string };
    result: { tree: FileTreeEntry[] };
  };
  'file:create': {
    params: { path: string };
    result: void;
  };
  'file:rename': {
    params: { from: string; to: string };
    result: void;
  };
  'file:delete': {
    params: { path: string };
    result: void;
  };
  'dialog:select-folder': {
    params: Record<string, never>;
    result: { path: string | null };
  };
  'shell:open-file': {
    params: { path: string };
    result: void;
  };
  'set-tests-dir': {
    params: { dir: string };
    result: void;
  };
}

// ---------------------------------------------------------------------------
// Preload API exposed to renderer via contextBridge
// ---------------------------------------------------------------------------
export interface ElectronBridgeApi {
  /** Send an event to main and wait for a typed response */
  invoke<K extends keyof RendererToMainInvokes>(
    channel: K,
    params: RendererToMainInvokes[K]['params'],
  ): Promise<RendererToMainInvokes[K]['result']>;

  /** Listen for events pushed from main */
  on<K extends keyof MainToRendererEvents>(
    channel: K,
    callback: (data: MainToRendererEvents[K]) => void,
  ): () => void;

  /** Initial data passed when the window is created */
  getInitialData(): Promise<{ testsDir: string }>;
}

// ---------------------------------------------------------------------------
// Extend the Window type for the renderer
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    electronBridge: ElectronBridgeApi;
  }
}
