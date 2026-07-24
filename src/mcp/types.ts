/**
 * The contract between the MCP server's parts.
 *
 * Defined up front and in one file because project resolution (W2), auto-start
 * (W4) and the tools (W3) are built independently against it. Everything a
 * tool needs is reachable from `McpDeps`, and every dependency is injectable —
 * the seam tests drive real tools against fakes, and the real-app test drives
 * a real client at an ephemeral port.
 */
import type { RunEvent } from '../server/session-manager.js';

// Type-only: `RunEvent` lives in session-manager, which value-imports
// playwright. `import type` erases at compile time, so nothing in this graph
// pulls a browser stack into the MCP process. Re-exported so the rest of
// src/mcp/ never has to reach into the server package itself.
export type { RunEvent };

// ---------------------------------------------------------------------------
// Project resolution (W2)
// ---------------------------------------------------------------------------

/** Everything derived from a confined project root, before any request. */
export interface ProjectContext {
  /** Absolute, realpath'd, confined to an allowed root. */
  projectRoot: string;
  /** Absolute path of the `aiui.config.json` that defined this root. */
  configPath: string;
  /** `.env` composed with `.env.<envName>`. Never includes `process.env`. */
  env: Record<string, string>;
  /** Resolved environment name, or null when none was given or declared. */
  envName: string | null;
  /** Base URL of the Sessions API. */
  serverUrl: string;
  apiKey: string;
  /** Absolute, confined, and known to exist — or null to omit from the wire. */
  skillsDir: string | null;
  toolsDir: string | null;
  cacheEnabled: boolean;
  /** Env files actually consulted, for error messages that name them. */
  envFilesConsulted: string[];
}

/** The body `POST /sessions/:id/steps` accepts. Mirrors the server's explicit
 *  allow-list — fields absent here are dropped at the route, silently. */
export interface McpStepRequest {
  steps: string[];
  sourceLines?: number[];
  sections?: Record<
    string,
    { name: string; headingLine: number; steps: string[]; stepLines: number[] }
  >;
  env?: Record<string, string>;
  envName?: string;
  config?: { baseUrl?: string; timeout?: string; cdp?: { port: number; tab?: string } };
  parameters?: Record<string, string>;
  dataSources?: Record<string, string>;
  skillsDir?: string;
  toolsDir?: string;
  cacheEnabled?: boolean;
  testFilePath?: string;
}

/** An assembled request plus everything the fold and the result need that is
 *  not on the wire. */
export interface AssembledRun {
  request: McpStepRequest;
  project: ProjectContext;
  /** Parallel to `request.steps`; the text the fold shows for root frames. */
  sentSteps: string[];
  /** Non-fatal problems worth telling the agent about. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// API client (W3)
// ---------------------------------------------------------------------------

export interface StreamResult {
  events: RunEvent[];
  /**
   * Wall-clock arrival time of each event, parallel to `events`.
   *
   * Captured here because it cannot be recovered later: the fold runs over the
   * collected array once the stream has closed, so timing it there measures
   * how fast the loop iterates, not how long a step took. That produced a
   * confident `durationMs: 0` on every step of a real run.
   */
  receivedAt: number[];
  /** True when the stream ended without a `done` event — the run may still be
   *  executing server-side. */
  streamDropped: boolean;
  /** Frames the reader could not parse. Surfaced as warnings by the fold,
   *  which is where `warnings[]` is assembled. */
  dropped: string[];
}

export interface LastRunInfo {
  finalized: boolean;
  reportPath?: string | null;
  tokens?: { total: number; input: number; output: number } | null;
}

export interface SessionSummary {
  sessionId: string;
  status?: string;
  currentUrl?: string;
  pageTitle?: string;
  totalStepsExecuted?: number;
}

export interface ApiClient {
  streamSteps(
    sessionId: string,
    body: McpStepRequest,
    signal?: AbortSignal,
    onEvent?: (event: RunEvent) => void,
  ): Promise<StreamResult>;
  getLastRun(sessionId: string): Promise<LastRunInfo>;
  closeSession(sessionId: string): Promise<void>;
  listSessions(signal?: AbortSignal): Promise<SessionSummary[]>;
}

/**
 * A non-2xx answer from the Sessions API.
 *
 * Worth its own type because the status genuinely changes what the agent
 * should be told, and several of the mappings are non-obvious: validation
 * 400s arrive as real HTTP even on the streaming path (they fire before
 * headers flush), a 503 means a concurrent `aiui stop` is draining the
 * server, and body-parser's 413 surfaces as a 500 because the error
 * middleware hardcodes the status.
 */
export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage: string,
  ) {
    super(`HTTP ${status}: ${serverMessage}`);
    this.name = 'ApiHttpError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Injected by tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** A factory, not an instance: base URL and key are per project, so a single
 *  client cannot serve two roots. */
export type CreateApiClient = (opts: ApiClientOptions) => ApiClient;

// ---------------------------------------------------------------------------
// Auto-start (W4)
// ---------------------------------------------------------------------------

/** Raised by `ensureServerReady` when no run can happen. Carries a ready-made
 *  tool error so handlers neither reformat nor lose the diagnostic. */
export class PreflightFailure extends Error {
  constructor(readonly toolError: import('./errors.js').McpToolError) {
    const first = toolError.content[0];
    super(first ? first.text : 'pre-flight failed');
    this.name = 'PreflightFailure';
  }
}

/**
 * Make sure a healthy Sessions API server is listening at `project.serverUrl`,
 * starting one if it is down and loopback. Throws `PreflightFailure`.
 */
export type EnsureServerReady = (
  project: ProjectContext,
  signal?: AbortSignal,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface ResolveProjectArgs {
  projectRoot?: string | undefined;
  /** Absolute test file path, when the caller has one; anchors the root walk. */
  testFilePath?: string | undefined;
  envName?: string | undefined;
}

export type ResolveProject = (args: ResolveProjectArgs) => Promise<ProjectContext>;

export interface McpDeps {
  createApiClient: CreateApiClient;
  ensureServerReady: EnsureServerReady;
  /**
   * Identity check for the tools that talk to the server without running
   * anything. Injected rather than imported so a test that fakes the client
   * does not also fire a real probe at a real port — and so a machine with
   * something else listening there cannot fail the suite.
   */
  assertServerRecognized: EnsureServerReady;
  resolveProject: ResolveProject;
}
