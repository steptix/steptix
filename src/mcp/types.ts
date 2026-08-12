/**
 * The contract between the MCP server's parts.
 *
 * Defined up front and in one file because project resolution (W2), auto-start
 * (W4) and the tools (W3) are built independently against it. Everything a
 * tool needs is reachable from `McpDeps`, and every dependency is injectable —
 * the seam tests drive real tools against fakes, and the real-app test drives
 * a real client at an ephemeral port.
 */
import type { ErrandSummary, ErrandTab, RunEvent } from '../server/session-manager.js';
import type {
  CaptureMode,
  EffectiveSettings,
  RunSettings,
  SettingSource,
} from '../config/types.js';

// Type-only: `RunEvent` lives in session-manager, which value-imports
// playwright. `import type` erases at compile time, so nothing in this graph
// pulls a browser stack into the MCP process. Re-exported so the rest of
// src/mcp/ never has to reach into the server package itself.
//
// `ErrandSummary` rides the `done` frame, so it is part of that same wire
// protocol and is re-exported for the same reason rather than re-declared —
// two hand-kept copies of a wire shape drift in the direction of whichever
// half gets edited.
export type { ErrandSummary, ErrandTab, RunEvent };

// Re-exported rather than re-declared. These travel the wire in both directions
// — `runSettings` out on the request, `effectiveSettings` back on `done` and on
// `GET /config` — and two hand-kept copies of a wire shape drift, silently, in
// the direction of the half that gets edited.
export type { CaptureMode, EffectiveSettings, RunSettings, SettingSource };

/**
 * What comes back to the CALLER, as distinct from what gets captured into the
 * report (stories/run-settings.md §4).
 *
 * MCP-only — it never reaches the server. The fold already sees every step's
 * screenshot; this decides which of them, if any, ends up as an image block in
 * the tool result. Deliberately no `every-step`: a 30-step run is 30 PNGs, and a
 * warning about that arrives after the images are already in the context window.
 */
export type ScreenshotsReturn = 'none' | 'on-failure' | 'final';

/**
 * What `screenshots_return` means when the caller says nothing (and what
 * `'default'` resolves to).
 *
 * `on-failure` because a failure is the one moment a picture says something the
 * text cannot: "could not find the Submit button" is not a diagnosis, and the
 * screenshot showing a cookie banner on top of it is. It costs nothing on a
 * passing run, which is most runs.
 *
 * The cost is real and deliberate rather than overlooked: an image is charged to
 * the caller's context, and it is a photograph of a live signed-in session. Both
 * are stated in the tool description so `none` is an informed choice, and the
 * existing size cap still drops anything oversized rather than shipping it.
 *
 * One constant, so the tool default and the meaning of `'default'` cannot drift
 * apart. `foldRun` takes the mode explicitly rather than defaulting again — a
 * second fallback is how two defaults start disagreeing.
 */
export const DEFAULT_SCREENSHOTS_RETURN: ScreenshotsReturn = 'on-failure';

/** `GET /config` — the effective server config plus the run settings in force. */
export interface ServerConfigReport {
  /** The server's own config with both api keys redacted to `apiKeySet`
   *  booleans. Shape deliberately loose: this is for reporting, and pinning it
   *  to `Config` would make every config addition a change here too. */
  config: Record<string, unknown>;
  server: EffectiveSettings;
  session: {
    sessionId: string;
    overrides: RunSettings;
    effective: EffectiveSettings;
  } | null;
}

// ---------------------------------------------------------------------------
// Project resolution (W2)
// ---------------------------------------------------------------------------

/**
 * Which root a call resolved against (stories/mcp-no-project.md).
 *
 * `project` — a directory whose `aiui.config.json` the config walk found.
 * `user` — the machine-wide user root (`%LOCALAPPDATA%\aiui` / `~/.aiui`),
 * used when no project resolved or when the caller addressed it explicitly.
 * The two are peers, not a hierarchy: browsers resolve against both, and a
 * name that exists in both is refused rather than decided by precedence.
 */
export type RootScope = 'project' | 'user';

/** Everything derived from a confined project root, before any request. */
export interface ProjectContext {
  /**
   * Which root this is. Carried on every run result (rule 7 of
   * stories/mcp-no-project.md): a typo'd config filename now produces a
   * *working* run against the user root, and the only thing that keeps that
   * from being a silent wrong answer is saying which root it was.
   */
  scope: RootScope;
  /**
   * Directories the config walk examined before falling back to the user
   * root. Empty for `scope: 'project'` and for a user root addressed
   * explicitly — non-empty only on the fallback path, where messages use it
   * to explain *why* there was no project.
   */
  configSearch: readonly string[];
  /** Absolute, realpath'd, confined to an allowed root. */
  projectRoot: string;
  /**
   * Absolute path of the `aiui.config.json` that defined this root.
   *
   * For `scope: 'user'` the file may not exist — nothing machine-writes it
   * (stories/mcp-no-project.md, locked) — but the path is still resolved,
   * because it is the file a human would have to create to widen
   * permissions, and refusal messages must be able to name it.
   */
  configPath: string;
  /** `.env` composed with `.env.<envName>`. Never includes `process.env`. */
  env: Record<string, string>;
  /** Resolved environment name, or null when none was given or declared. */
  envName: string | null;
  /** Base URL of the Sessions API. */
  serverUrl: string;
  /**
   * The key sent with every request, or null when no source had one — the
   * project `.env`, `process.env` and the machine key file all came up empty
   * (stories/machine-key.md).
   *
   * Null is a *deferral*, not an error: only `server-start.ts` can decide
   * what a missing key means, because the answer depends on the server's
   * state. Down + loopback → generate one and spawn with it. Already running
   * → refuse, naming the file to write; a generated key would just be
   * rejected by a server that already holds a different one.
   */
  apiKey: string | null;
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
  /**
   * Per-session run settings (stories/run-settings.md §1).
   *
   * A new field on the wire, NOT part of the `## Config` string merge — those
   * are per-key strings projected onto `config`, and this is an object with its
   * own retention and clearing semantics. Keeping them apart is why a tool
   * argument here cannot be mistaken for something a test file declared.
   */
  runSettings?: RunSettings;
}

/**
 * The body `POST /errands` accepts (stories/errands.md).
 *
 * Mirrors `parseErrandRequest`'s allow-list, which is the same hazard
 * `McpStepRequest` carries: the server BUILDS its request object field by
 * field, so widening a type here compiles cleanly and drops the value at
 * runtime.
 *
 * No `sessionId`, and there is nowhere to put one — that absence is the tool's
 * whole contract. No run-settings either: an errand has no session to hold
 * overrides, so the chain is server base → project bundle.
 */
export interface ErrandRequestBody {
  /** Resolved MCP-side from profile + engine + scope. The server is handed the
   *  answer, never the name. */
  port: number;
  /** The winner of the two-stage match, exact — so the first-match-wins arm of
   *  `resolveCdpTab` is never asked to arbitrate. */
  targetId: string;
  steps: string[];
  /** The synthetic `<root>/.aiui-errand.md`. The only thing the server resolves
   *  a project root from; without it the project layer of `effectiveSettings`
   *  falls back to server defaults with nothing saying so. */
  testFilePath: string;
  /** Echoed into the receipt: every result says which root it used
   *  (stories/mcp-no-project.md §Locked). */
  root: string;
  scope: RootScope;
  /** Leave errand-opened TABS behind. Never spares a browser a step opened. */
  keepOpen?: boolean;
  /** Without it the server builds no env bundle and `${env.X}` reaches the AI
   *  as literal text — there is no default-env concept. */
  envName?: string;
  /** The project's composed `.env`, exactly as `run_steps` sends it: this is
   *  how a project's own AI_API_KEY and AI_MODEL reach the run instead of the
   *  server process's. */
  env?: Record<string, string>;
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
  /** Settles a profile name that exists in both roots. A separate field, not
   *  a prefix on the name — `PROFILE_NAME_PATTERN` refuses `/` because the
   *  name is a path component that later feeds a recursive delete. */
  scope?: RootScope | undefined;
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
  /** The tab this session is currently on. Same optionality rule as `cdp`. */
  tab?: { targetId: string | null; url: string } | null;
}

// ---------------------------------------------------------------------------
// CDP browsers (stories/mcp-cdp-browser.md §4)
// ---------------------------------------------------------------------------

export interface CdpTab {
  targetId: string;
  title: string;
  url: string;
  /**
   * The live session driving this tab, or null when nothing is.
   *
   * Optional on the type because a server older than this field omits it
   * entirely; the tool layer normalises a missing value to null. Advisory
   * only — a session that bound the tab after this listing was taken is
   * caught by the close-time guard, which is the authoritative one.
   */
  sessionId?: string | null;
}

/**
 * Three lists, not one, and membership is what carries the meaning. A single
 * array distinguished by `reachable`/`port: null`/`owner` made a reader — human
 * or model — join four fields to work out what it was looking at, and the
 * obvious misreading of "3 browsers" was two directories and someone else's
 * Chrome. Each list here has exactly one meaning and one permitted action.
 */
export interface CdpBrowsers {
  /** Live browsers from BOTH roots — the project's and the user root's, each
   *  entry tagged with which (stories/mcp-no-project.md). Attach by passing
   *  `port` as `config.cdp`. `scope` is optional on the wire because a
   *  Sessions API server predating it omits the field; the tool layer
   *  normalises a missing value to `'project'`, the only scope such a server
   *  can have swept. */
  running: {
    engine: string;
    profile: string;
    port: number;
    profileDir: string;
    tabs: CdpTab[];
    scope?: RootScope;
  }[];
  /** Profiles (from both roots) with nothing running. Launch one by name —
   *  these are directories, not browsers, and deliberately have no port
   *  field. */
  available: { engine: string; profile: string; profileDir: string; scope?: RootScope }[];
  /** Browsers tracing back to NEITHER root. Nothing may be done with these
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
  /** Which root the browser lives under. Optional for the usual reason: an
   *  older Sessions API server omits it, and the tool layer normalises to the
   *  scope it asked the launch into. */
  scope?: RootScope;
}

/** Address of one tab to close (stories/cdp-tabs.md §2). */
export interface CloseCdpTabArgs {
  projectRoot: string;
  port: number;
  targetId: string;
  /** Permission to close a browser's last tab, which ends the browser. */
  allowBrowserExit?: boolean;
  /** Sent only when `mcp.cdp.allowUnowned` permits, exactly like
   *  `includeForeignTabs` on the listing: the server honours what it is asked,
   *  and not asking is the withholding. */
  allowUnowned?: boolean;
}

export interface ClosedCdpTab {
  closed: boolean;
  targetId: string;
  title: string;
  url: string;
  engine: string;
  profile: string;
  port: number;
  remainingTabs: number;
  /** Observed, not assumed — the port stopped answering. */
  browserExited: boolean;
  /**
   * Whether this project launched the browser.
   *
   * Optional for the same reason `SessionSummary.cdp` and `CdpTab.sessionId`
   * are: a Sessions API server predating the field omits it, and the type
   * should say so rather than letting the handler assume otherwise. The tool
   * derives a safe value when it is missing — it is required in the *output*
   * schema, so guessing wrong here is a failure after an irreversible act.
   */
  owned?: boolean;
  warnings?: string[];
  /** Which root owned the browser, or absent for a foreign one (and from a
   *  Sessions API server predating the field). */
  scope?: RootScope;
}

/** Address of one tab to bring to the front (stories/cdp-tab-focus.md §2).
 *
 *  No `allowBrowserExit` sibling and no session flag: focusing closes nothing
 *  and re-binds nothing, so ownership is the only permission in play. */
export interface FocusCdpTabArgs {
  projectRoot: string;
  port: number;
  targetId: string;
  /** Sent only when `mcp.cdp.allowUnowned` permits — the same gate as attaching
   *  and closing. Focusing a tab in someone else's browser yanks a human's
   *  screen and reveals which tab they are being shown. */
  allowUnowned?: boolean;
}

export interface FocusedCdpTab {
  /**
   * The browser accepted the request.
   *
   * Deliberately weaker than `ClosedCdpTab.closed`, and the asymmetry is honest
   * rather than lazy: a closed tab has an observable absence to poll for, while
   * "is this tab frontmost, and is its window in front of every other
   * application" has no reliable read over the DevTools HTTP surface.
   */
  focused: boolean;
  targetId: string;
  title: string;
  url: string;
  engine: string;
  profile: string;
  port: number;
  /** Optional for the same reason `ClosedCdpTab.warnings` is: an older Sessions
   *  API server may omit it, and it is required in the output schema. */
  warnings?: string[];
  /** Which root owned the browser, or absent for a foreign one (and from a
   *  Sessions API server predating the field). */
  scope?: RootScope;
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

/**
 * `GET /sessions/:id` — session state, including a screenshot of the active
 * page (stories/run-settings.md §7).
 *
 * The screenshot is what this is here for: the endpoint has always returned one
 * and the MCP simply did not expose it, so "show me what the page looks like
 * now" needs no new capture code on the server.
 */
export interface SessionStateSnapshot {
  sessionId: string;
  status: 'active' | 'executing' | 'queued';
  currentUrl: string;
  pageTitle: string;
  /**
   * `data:image/png;base64,…` — or the EMPTY STRING when the capture failed.
   *
   * The server swallows capture errors into `''`, so an empty value here means
   * "we could not photograph the page", never "the page is blank". Callers must
   * treat it as an error; reporting a blank page is the one answer that cannot
   * be corrected by whoever reads it.
   */
  screenshot: string;
  totalStepsExecuted: number;
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
  /**
   * `POST /errands?stream=1` — borrow a tab, drive it, hand it back.
   *
   * Same `StreamResult` as `streamSteps`, because it is the same event stream:
   * the errand's own accounting rides the `done` frame, so the fold that turns
   * events into `steps[]` + `captures{}` serves both.
   */
  runErrand(
    body: ErrandRequestBody,
    signal?: AbortSignal,
    onEvent?: (event: RunEvent) => void,
  ): Promise<StreamResult>;
  getLastRun(sessionId: string): Promise<LastRunInfo>;
  getPageContent(
    sessionId: string,
    args: GetPageContentArgs,
    signal?: AbortSignal,
  ): Promise<PageContent>;
  /** `GET /sessions/:id`, for the screenshot it already carries (§7). */
  getSessionState(sessionId: string, signal?: AbortSignal): Promise<SessionStateSnapshot>;
  /** `GET /config`. `sessionId` adds that session's retained overrides; an
   *  unknown one answers 404, which surfaces as an `ApiHttpError`. */
  getConfig(sessionId?: string, signal?: AbortSignal): Promise<ServerConfigReport>;
  closeSession(sessionId: string): Promise<void>;
  listSessions(signal?: AbortSignal): Promise<SessionSummary[]>;
  getCdpBrowsers(args: GetCdpBrowsersArgs, signal?: AbortSignal): Promise<CdpBrowsers>;
  startCdpBrowser(body: StartCdpBrowserBody, signal?: AbortSignal): Promise<StartedCdpBrowser>;
  closeCdpTab(args: CloseCdpTabArgs, signal?: AbortSignal): Promise<ClosedCdpTab>;
  focusCdpTab(args: FocusCdpTabArgs, signal?: AbortSignal): Promise<FocusedCdpTab>;
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

/**
 * A 404 whose body was **not this server's JSON error envelope** — so the
 * *route* is absent, not the thing the route addresses.
 *
 * The two readings of a 404 mean opposite things to whoever is reading. Our
 * routes answer `{ error: "<prose>" }`; a Sessions API server from a build that
 * predates a route has no such route, so Express answers its own 404 with an
 * HTML document. Telling an agent its tab was closed when the truth is "rebuild
 * the server" sends the user looking for a window that is still sitting there.
 *
 * **A distinct type rather than an empty `serverMessage`.** Inferring
 * route-missing from an absent message was one substitution away from being
 * wrong: any body that parses as JSON but carries a non-string `error` (or an
 * error object, or `message`) would leave the message empty and be reported as
 * a stale server. The client knows which of the two it saw; it should say so
 * rather than leave the next layer to guess from a hole.
 */
export class ApiRouteNotFoundError extends ApiHttpError {
  constructor(readonly url: string) {
    super(404, '');
    this.name = 'ApiRouteNotFoundError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Null only on `assertServerRecognized`'s down path, where the request is
   *  about to fail on connect before any header matters. Every healthy path
   *  resolves a real key before a client is built. */
  apiKey: string | null;
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
  /**
   * Refuse rather than fall back to the user root when no project resolves.
   *
   * For `run_test_file` and `list_test_files`: test files, skills and tools
   * are project-shaped, and the user root deliberately has none
   * (stories/mcp-no-project.md). Every other tool leaves this unset and gets
   * the user-scope fallback.
   */
  requireProject?: boolean | undefined;
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
