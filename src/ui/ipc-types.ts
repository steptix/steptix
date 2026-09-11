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
  /** `'skipped'` is a step the run decided against, or one it left behind:
   *  the untaken half of a chain, a loop body that never ran, an `[input:]`
   *  in an unattended run (stories/control-flow.md), or a step a `return` /
   *  `stop` walked past (stories/step-flow-control.md). Not a failure and not
   *  a pass: painting it as either loses the one thing a decision leaves
   *  behind, which is which way it went. */
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  /** The failure was tolerated and the run went on — `otherwise continue`
   *  (stories/step-failure-outcomes.md, decision 6). A property of a `'failed'`
   *  step rather than a status of its own, so readers that switch on `status`
   *  keep working. */
  tolerated?: boolean;
  /** The author's words for a tolerated failure — `otherwise continue with
   *  warning "…"`. Shown ahead of `error`, which stays the framework's account
   *  of what actually went wrong. */
  warning?: string;
  /** The author wrote this failure, in their own words (decision 2). */
  deliberate?: boolean;
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
    /** `skipped` carries no failure: the step was left behind by a `return`
     *  (stories/step-flow-control.md) or decided against by a chain or loop
     *  guard (stories/control-flow.md), and its `error` is absent. */
    status: 'passed' | 'failed' | 'skipped';
    durationMs: number;
    error?: string;
    /** Why a skipped step never ran, e.g. `Not run: step 3 returned from
     *  "Sign in"`, or `Step 4 chose another branch`. Set only with
     *  `status: 'skipped'`. */
    reason?: string;
    /** The step failed and the run CARRIED ON past it — the `otherwise continue`
     *  tail (stories/step-failure-outcomes.md, decisions 6 and 9). `status` stays
     *  `'failed'`, so every existing reader keeps working; the panel paints this
     *  one amber. */
    tolerated?: boolean;
    /** The author's own words for a tolerated failure — the quoted text of
     *  `… otherwise continue with warning "…"`, interpolated and masked, sent only
     *  with `tolerated`. Beside `error` rather than instead of it: `error` stays
     *  the framework's account of what went wrong, this says why the author
     *  decided it was survivable. The panel's amber log line leads with it. */
    warning?: string;
    /** The author wrote this failure — the `fail` verb (decision 2). `error` is
     *  their sentence, so the log line says "failed as written" rather than
     *  reporting a malfunction. */
    deliberate?: boolean;
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
