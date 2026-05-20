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

/** Where a session-scope variable came from. A closed union; new sources
 *  require a protocol bump. See stories/output-source-tagging.md. */
export type OutputSource = 'parameter' | 'capture' | 'toolOutput';

/** The result of one submitted batch of steps, persisted into session history. */
export interface BatchResult {
  status: BatchStatus;
  stepsCompleted: number;
  stepsTotal: number;
  results: StepResult[];
  /** Outputs newly accumulated by this batch. */
  outputs: Record<string, string>;
  /** Per-key provenance for `outputs` (same keys), labelled by source.
   *  Optional and additive — absent when talking to an older server, in
   *  which case the UI falls back to a single un-labelled outputs block. */
  outputSources?: Record<string, OutputSource>;
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
  /** Present iff this session is CDP-attached. Drives the topbar badge and
   *  is included as `cdp` in the first request's `config` payload. */
  cdp?: CdpAttachment;
}

export interface CdpAttachment {
  port: number;
  /** Tab selector passed verbatim to the runner's parseCdpTabSpec — e.g.
   *  "targetId:ABC123" or "new". */
  tab: string;
}

/** `node` = a Node.js `--inspect` endpoint, which also speaks CDP and answers
 *  /json/version but is NOT an attachable browser. It's classified so the
 *  dropdown can filter it out (port 9229 is the Node inspector default and
 *  collides with our scan list). */
export type CdpEngine = 'chrome' | 'edge' | 'chromium' | 'node' | 'unknown';

export interface CdpDiscoveryTab {
  targetId: string;
  title: string;
  url: string;
  faviconUrl?: string;
}

export interface CdpDiscoveryPort {
  port: number;
  /** True once /json/version returned 2xx — i.e. a CDP browser is actually
   *  listening. Distinguishes "nothing on this port" (false) from "browser
   *  present but /json/list failed" (true, tabs: null); both otherwise look
   *  like engine:'unknown', tabs:null. The dropdown only renders reachable
   *  ports. */
  reachable: boolean;
  /** Parsed from /json/version's `Browser` field. 'unknown' for Chromium
   *  variants whose Browser string doesn't match a known prefix. */
  engine: CdpEngine;
  /** null = port reachable but enumeration failed; empty array = reachable, no pages. */
  tabs: CdpDiscoveryTab[] | null;
  error?: string;
}

/** Which launch buttons the dropdown shows. */
export interface CdpInstalledBrowsers {
  chrome: boolean;
  edge: boolean;
  /** Last-used engine, persisted per-workspace; null on first run. When both
   *  Chrome and Edge are installed, the dropdown shows the lastLaunched
   *  engine's button first. */
  lastLaunched: 'chrome' | 'edge' | null;
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
  | { type: 'serverSessions'; sessions: ServerSessionItem[] | null; error: string | null }
  /** Reply to the webview's `discoverCdp` request. `installed` tells the
   *  webview which launch buttons to render. */
  | { type: 'cdpDiscovery'; ports: CdpDiscoveryPort[]; installed: CdpInstalledBrowsers }
  /** Result of a `launchBrowserCdp` action. On success `port` is the port the
   *  browser is listening on (so the webview can re-discover). */
  | { type: 'cdpLaunchResult'; engine: 'chrome' | 'edge'; ok: boolean; port?: number; error?: string };

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
  | { type: 'adoptServerSession'; item: ServerSessionItem }
  /** Refresh request — host responds with a `cdpDiscovery` message. */
  | { type: 'discoverCdp' }
  /** Adopt an existing CDP tab as a new local session. Tab is selected via
   *  the stable `targetId` so the runner can attach to that exact page. */
  | { type: 'adoptCdpTab'; port: number; targetId: string; title?: string; url?: string }
  /** Adopt a CDP browser via a brand-new tab (runner opens it, closes it
   *  at teardown). */
  | { type: 'newTabInCdp'; port: number }
  /** Spawn Chrome or Edge with --remote-debugging-port=port. */
  | { type: 'launchBrowserCdp'; engine: 'chrome' | 'edge'; port: number };
