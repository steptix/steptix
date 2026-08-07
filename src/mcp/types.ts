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
  /**
   * `mcp.cdp` from `aiui.config.json` — how much reach an agent has over CDP
   * browsers (stories/mcp-cdp-browser.md §6).
   *
   * Resolved here, once, rather than re-read at the moment the gate runs. Two
   * reasons: the gate is on the hot path of every CDP run, and a permission
   * that is re-read mid-flight could change between the check and the use.
   * Absent or malformed config reads as "not permitted" — widening reach is an
   * explicit act, so anything ambiguous stays closed.
   */
  cdpPermissions: { allowUnowned: boolean; ports: number[] | null };
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
  /**
   * Where `request.config.cdp` came from, or `null` when there is none.
   *
   * On the wire the two are identical, so this is the only thing that says
   * which rule applies: a `## Config: cdp:` line is human-authored and trusted,
   * while a tool argument is a model's choice and must clear §6's gate first.
   * Losing this distinction would silently make every agent-chosen browser
   * trusted, which is the failure the whole gate exists to prevent.
   */
  cdpSource: 'file' | 'tool' | null;
  /**
   * The tool-supplied `config.cdp` exactly as it arrived, unresolved.
   *
   * Only set when `cdpSource === 'tool'`. It may address a browser by
   * `profile` rather than `port`, and resolving that needs a live registry
   * round-trip `assemble.ts` has no client for — so the raw target travels
   * here and `tools.ts` turns it into `request.config.cdp`.
   */
  cdpTarget: CdpTarget | null;
}

/** A tool-supplied `config.cdp` before its address has been resolved. Lives
 *  here rather than in `cdp.ts` so `cdp.ts` can keep value-importing this
 *  module without a cycle. */
export interface CdpTarget {
  profile?: string | undefined;
  engine?: string | undefined;
  port?: number | undefined;
  tab?: string | undefined;
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
  /** Which CDP browser this session drives. Optional because a server older
   *  than this field simply omits it. */
  cdp?: { port: number; profile: string | null } | null;
}

// ---------------------------------------------------------------------------
// CDP browsers (stories/mcp-cdp-browser.md §4)
// ---------------------------------------------------------------------------

export interface CdpTab {
  targetId: string;
  title: string;
  url: string;
}

/**
 * Three lists, not one, and membership is what carries the meaning. A single
 * array distinguished by `reachable`/`port: null`/`owner` made a reader — human
 * or model — join four fields to work out what it was looking at, and the
 * obvious misreading of "3 browsers" was two directories and someone else's
 * Chrome. Each list here has exactly one meaning and one permitted action.
 */
export interface CdpBrowsers {
  /** This project's live browsers. Attach by passing `port` as `config.cdp`. */
  running: {
    engine: string;
    profile: string;
    port: number;
    profileDir: string;
    tabs: CdpTab[];
  }[];
  /** This project's profiles with nothing running. Launch one by name — these
   *  are directories, not browsers, and deliberately have no port field. */
  available: { engine: string; profile: string; profileDir: string }[];
  /** Browsers this project did not start. Nothing may be done with these
   *  without the §6 opt-in, and their tabs are withheld by default. */
  foreign: {
    engine: string;
    port: number;
    tabs: CdpTab[] | null;
    tabsWithheld: boolean;
    error: string | null;
  }[];
}

export type CdpOutcome =
  | 'reused_running_browser'
  | 'launched_into_existing_profile'
  | 'launched_into_new_profile'
  | 'launched_after_reset';

export interface StartCdpBrowserBody {
  projectRoot: string;
  engine: 'chrome' | 'edge';
  profile?: string;
  reset?: boolean;
}

export interface StartedCdpBrowser {
  engine: string;
  profile: string;
  port: number;
  profileDir: string;
  binary: string;
  tabs: CdpTab[];
  outcome: CdpOutcome;
  warnings: string[];
}

export interface GetCdpBrowsersArgs {
  projectRoot: string;
  includeForeign?: boolean;
  /** Ask the server for foreign tab titles and URLs. Set only when §6's
   *  `allowUnowned` permits — the server honours whatever it is asked, since
   *  it cannot tell an agent from a human. */
  includeForeignTabs?: boolean;
}

/** Query for `GET /sessions/:id/content`. Omitted fields take the server's
 *  defaults (`text`, whole page, 20 000 chars). */
export interface GetPageContentArgs {
  format?: 'text' | 'dom' | undefined;
  selector?: string | undefined;
  maxChars?: number | undefined;
}

/** The page as read — mirrors the Sessions API response body. */
export interface PageContent {
  sessionId: string;
  url: string;
  title: string;
  status: 'active' | 'executing';
  format: 'text' | 'dom';
  selector: string | null;
  content: string;
  truncated: boolean;
  returnedChars: number;
  availableChars: number;
}

export interface ApiClient {
  streamSteps(
    sessionId: string,
    body: McpStepRequest,
    signal?: AbortSignal,
    onEvent?: (event: RunEvent) => void,
  ): Promise<StreamResult>;
  getLastRun(sessionId: string): Promise<LastRunInfo>;
  getPageContent(
    sessionId: string,
    args: GetPageContentArgs,
    signal?: AbortSignal,
  ): Promise<PageContent>;
  closeSession(sessionId: string): Promise<void>;
  listSessions(signal?: AbortSignal): Promise<SessionSummary[]>;
  getCdpBrowsers(args: GetCdpBrowsersArgs, signal?: AbortSignal): Promise<CdpBrowsers>;
  startCdpBrowser(body: StartCdpBrowserBody, signal?: AbortSignal): Promise<StartedCdpBrowser>;
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
