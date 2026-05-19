// Message protocol and shared data shapes for the Flick extension <-> webview bridge.
// This file is imported by both the extension host (Node) and the webview (browser),
// so it must contain types only — no runtime dependencies on either environment.

// ---------------------------------------------------------------------------
// Sessions API shapes (subset of SPEC-SESSIONS-API.md that the UI consumes)
// ---------------------------------------------------------------------------

export type StepStatus = 'passed' | 'failed' | 'error';
export type BatchStatus = 'passed' | 'failed' | 'error';

export interface StepAction {
  /** Action kind — e.g. 'click', 'navigate', 'assert'. Matches the
   *  server's `AIAction.action` field, NOT `type` (an earlier mismatch
   *  caused "undefined" to render in the Actions panel). */
  action: string;
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

/**
 * One entry returned by GET /sessions — the server's view of an active
 * browser session. Mirrors `SessionListItem` server-side so the webview
 * and the host agree on shape without dragging in a runtime dependency.
 */
export interface ServerSessionItem {
  sessionId: string;
  status: string;
  currentUrl: string;
  pageTitle: string;
  totalStepsExecuted: number;
}

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
  | { type: 'showSettings' }
  /**
   * Response to the webview's `listServerSessions` request. Carries either
   * a list (possibly empty) or an `error` string when the host couldn't
   * reach the server. The webview drives loading state off the request
   * lifecycle, so no separate "loading" payload is needed.
   */
  | { type: 'serverSessions'; sessions: ServerSessionItem[] | null; error: string | null };

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
  | { type: 'saveSettings'; settings: FlickSettings }
  /** Fetch the current list of server-side sessions for the adopt dropdown. */
  | { type: 'listServerSessions' }
  /**
   * Attach an existing server session as a local Flick tab. The host
   * dedupes by sessionId: if a local tab already represents this id the
   * tab is just activated, not duplicated.
   */
  | { type: 'adoptServerSession'; item: ServerSessionItem };
