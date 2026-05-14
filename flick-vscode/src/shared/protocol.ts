// Message protocol and shared data shapes for the Flick extension <-> webview bridge.
// This file is imported by both the extension host (Node) and the webview (browser),
// so it must contain types only — no runtime dependencies on either environment.

// ---------------------------------------------------------------------------
// Sessions API shapes (subset of SPEC-SESSIONS-API.md that the UI consumes)
// ---------------------------------------------------------------------------

export type StepStatus = 'passed' | 'failed' | 'error';
export type BatchStatus = 'passed' | 'failed' | 'error';

export interface StepAction {
  type: string;
  [key: string]: unknown;
}

/** A single step result as returned by the API, after screenshot extraction. */
export interface StepResult {
  step: string;
  status: StepStatus;
  actions: StepAction[];
  reasoning: string;
  outputs: Record<string, string>;
  /** Webview-resolvable URI of the saved screenshot, or null if none. */
  screenshotUri: string | null;
}

/** The result of one submitted batch of steps, persisted into session history. */
export interface BatchResult {
  status: BatchStatus;
  stepsCompleted: number;
  stepsTotal: number;
  results: StepResult[];
  /** Outputs newly accumulated by this batch. */
  outputs: Record<string, string>;
  error: { step: number; message: string } | null;
}

// ---------------------------------------------------------------------------
// Local persisted model
// ---------------------------------------------------------------------------

export interface SessionMeta {
  /** GUID — used as the API :id parameter. */
  id: string;
  name: string;
  /** Position in the tab row. */
  order: number;
  /** True once the API has reported this GUID as missing (404). */
  stale: boolean;
  /** True once at least one batch has been sent (so config is no longer sent). */
  used: boolean;
}

export type HistoryEntry =
  | { kind: 'user'; id: string; ts: number; text: string }
  | { kind: 'result'; id: string; ts: number; batch: BatchResult }
  | { kind: 'pending'; id: string; ts: number };

export interface FlickSettings {
  apiUrl: string;
  apiKey: string;
  defaultBaseUrl: string;
  defaultTimeout: string;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';

// ---------------------------------------------------------------------------
// Host -> Webview messages
// ---------------------------------------------------------------------------

export type HostToWebview =
  | {
      type: 'init';
      sessions: SessionMeta[];
      activeSessionId: string | null;
      settings: FlickSettings;
      connection: ConnectionStatus;
    }
  | { type: 'sessions'; sessions: SessionMeta[]; activeSessionId: string | null }
  | { type: 'history'; sessionId: string; entries: HistoryEntry[] }
  | { type: 'historyAppend'; sessionId: string; entry: HistoryEntry }
  | { type: 'historyReplace'; sessionId: string; entryId: string; entry: HistoryEntry }
  | { type: 'connection'; connection: ConnectionStatus }
  | { type: 'settings'; settings: FlickSettings }
  | { type: 'toast'; level: 'info' | 'error'; message: string }
  | { type: 'busy'; sessionId: string; busy: boolean }
  | { type: 'showSettings' };

// ---------------------------------------------------------------------------
// Webview -> Host messages
// ---------------------------------------------------------------------------

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'submitSteps'; sessionId: string; rawText: string }
  | { type: 'newSession' }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'renameSession'; sessionId: string; name: string }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'requestHistory'; sessionId: string }
  | { type: 'openSettings' }
  | { type: 'saveSettings'; settings: FlickSettings };
