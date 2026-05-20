export interface AiConfig {
  /** Base URL for the aiapi gateway */
  gatewayUrl: string;
  /** Bearer token for authentication */
  apiKey?: string;
  /** Model identifier */
  model: string;
  /** Maximum input tokens per request */
  maxInputTokens: number;
  /** Use streaming endpoint instead of vision */
  streamResponses: boolean;
  /** Include a screenshot in each AI request (set false to reduce token usage) */
  sendScreenshots: boolean;
  /** Run a post-failure AI diagnosis pass and attach the result to the report */
  diagnoseFailures: boolean;
}

/**
 * Group of independent toggles that reduce DOM-snapshot noise — the
 * primary lever for keeping AI input compact on framework-heavy pages.
 *
 * Each flag is independent. Hard-cap settings that are NOT noise filters
 * (`maxIframeDepth`, `domSnapshotCharLimit`) live flat on `BrowserConfig`
 * since they're safety guards rather than reductions.
 */
export interface DomNoiseReductionConfig {
  /** Collapse long repetitive sibling runs (table rows, list items, card
   *  grids) in DOM snapshots into head + omission marker + tail. Reduces
   *  token usage on pages with hundreds of similar elements. Default true. */
  collapseRepetitiveDom?: boolean | undefined;
  /** Strip inner geometry (paths, shapes) from <svg> elements in DOM
   *  snapshots, keeping the opening tag + <title>/<desc> children only.
   *  Large SVG icon sets are the biggest per-element token cost on many
   *  sites. Default true. */
  compactSvg?: boolean | undefined;
  /** Drop `<input type="hidden">` elements from DOM snapshots. They are
   *  never interactable by the AI and often carry long opaque values
   *  (CSRF tokens, encoded state). Default true. */
  hideHiddenInputs?: boolean | undefined;
  /** Drop elements (and their subtrees) whose computed style is
   *  `display: none`. Slightly costlier to detect — requires
   *  `getComputedStyle` per element — but cuts large amounts of
   *  off-screen template/menu markup on many SPAs. Default true. */
  hideDisplayNoneElements?: boolean | undefined;
  /** Drop elements (and their subtrees) marked `aria-hidden="true"`.
   *  Default true. */
  hideAriaHiddenElements?: boolean | undefined;
  /** Restrict attributes emitted in the whole-page DOM snapshot to a
   *  curated allowlist (id, data-testid, name, type, role, aria-*, alt,
   *  label, etc.). Drops framework noise like `data-react-*`, `data-emotion`,
   *  long Tailwind/Bootstrap class strings, etc. Default true. */
  useDomAttributeAllowlist?: boolean | undefined;
  /** Drop `id` attributes that match known framework-generated unstable
   *  patterns (React 18 useId, Radix UI, Headless UI, MUI, React server-
   *  streaming). Prevents the AI from picking a selector that won't
   *  survive the next render. Default false (opt-in). */
  dropUnstableIds?: boolean | undefined;
}

export interface BrowserConfig {
  /** Show browser window (false = headless) */
  headed: boolean;
  /** Headless browser viewport dimensions */
  viewport: { width: number; height: number };
  /** Headed browser window dimensions */
  windowSize: { width: number; height: number };
  /** Milliseconds to wait between Playwright actions (for debugging) */
  slowMo: number;
  /** Browser engine to use */
  browser: 'chromium' | 'firefox' | 'webkit';
  /** Capture full-page screenshots (entire scrollable page) instead of viewport-only */
  fullPageScreenshots: boolean;
  /** Apply puppeteer-extra-plugin-stealth to Chromium. Some sites (e.g. Polymer 1
   *  stacks) break when stealth monkey-patches navigator/chrome internals — turn
   *  this off to load such sites. Chromium only; default true. */
  stealth?: boolean;
  /** Bypass Content-Security-Policy on the page. Useful when CSP blocks scripts
   *  the site itself needs (cascading failures). Default false. */
  bypassCSP?: boolean;
  /** DOM snapshot noise-reduction toggles — the primary lever for keeping
   *  AI input compact on framework-heavy pages. See DomNoiseReductionConfig. */
  domNoiseReduction?: DomNoiseReductionConfig | undefined;
  /** Maximum nesting depth for recursive iframe content capture in DOM
   *  snapshots. Iframes deeper than this are emitted as a placeholder
   *  comment instead of recursing. Default 5. */
  maxIframeDepth?: number | undefined;
  /** Hard character cap on the rendered DOM snapshot. Snapshots that exceed
   *  this length are truncated with a marker. Prevents runaway token usage
   *  on pathologically large pages. Default 300000. */
  domSnapshotCharLimit?: number | undefined;
  /** Capture a screenshot before/after every action and on each AI turn.
   *  When `false`, per-action screenshots are skipped to reduce runtime cost,
   *  but end-of-step and on-failure captures still fire so HTML reports
   *  retain visual context.
   *  Note: when `ai.sendScreenshots` is true, screenshots are still captured
   *  per turn regardless of this flag — the AI needs them in its request.
   *  Default true. */
  captureScreenshotsPerAction?: boolean | undefined;
}

export interface TestsConfig {
  /** Directory containing test .md files */
  dir: string;
  /** Directory containing context .md files */
  contextDir: string;
  /** Directory containing skill .md files (reusable parameterised step macros) */
  skillsDir: string;
  /** Directory containing tool .ts/.js files (deterministic code callable from
   *  tests via `[tool: name ...]`). Files are auto-discovered at run start;
   *  each must default-export a `defineTool(...)` result. */
  toolsDir: string;
  /** Glob pattern for discovering test files */
  pattern: string;
}

/**
 * Project-level default hooks merged into every test's `## Hooks` section.
 * Per-test `hooks: replace` frontmatter disables merging for that test.
 */
export interface DefaultHooksConfig {
  before?: string[];
  beforeEach?: string[];
  afterEach?: string[];
  after?: string[];
}

export interface ExecutionConfig {
  /** Default test timeout in milliseconds */
  timeout: number;
  /** Number of retries per failed step */
  retries: number;
  /** Capture screenshot on step failure */
  screenshotOnFailure: boolean;
  /** Ask user when AI cannot determine next action */
  promptOnAmbiguity: boolean;
  /** Maximum number of AI turns per step for multi-turn execution (default: 15) */
  maxTurns: number;
  /** Drop into a REPL when a step fails after retries (headed + TTY only). */
  interactiveOnFailure: boolean;
  /** Default `## Hooks` entries merged into every test unless the test sets
   *  `hooks: replace` in frontmatter. */
  defaultHooks?: DefaultHooksConfig;
}

export interface ReportsConfig {
  /** Directory to write HTML reports */
  outputDir: string;
  /** Include screenshots in report */
  includeScreenshots: boolean;
  /** Include DOM snapshots in report */
  includeDomSnapshots: boolean;
  /** Include AI reasoning trace in report */
  includeAiReasoning: boolean;
  /** Embed screenshots as base64 (vs separate files) */
  embedScreenshots: boolean;
  /** After a test run completes, open the last generated HTML report in the OS
   *  default browser. Driven by the OPEN_REPORT_IN_BROWSER_AFTER_RUN env var.
   *  Skipped automatically when the `CI` env var is set. */
  openInBrowserAfterRun: boolean;
  /** After a test completes, append a "Latest runs" section at the bottom of
   *  the test .md file linking to generated HTML reports. Driven by the
   *  APPEND_RUN_HISTORY_TO_TEST_FILE env var. Default false. */
  appendRunHistoryToTestFile: boolean;
}

export interface ApiConfig {
  /** Directory to cache downloaded OpenAPI/Swagger specs */
  specsDir: string;
  /** Default timeout per API request in milliseconds */
  requestTimeout: number;
  /** Redact auth values (API keys, tokens, cookies) in HTML reports */
  redactSensitive: boolean;
}

export interface ServerConfig {
  /** Host to bind the API server to */
  host: string;
  /** Port to listen on */
  port: number;
  /** API key for authentication (checked via x-api-key header) */
  apiKey: string;
}

export interface CacheConfig {
  /** Enable AI response caching for test steps */
  enabled: boolean;
  /** Directory for cache storage (relative to project root) */
  dir: string;
}

/**
 * Logging configuration. Controls what gets emitted to the console / SSE
 * output panel and what gets written to the per-run log file under
 * `reports/logs/`.
 */
export interface LoggingConfig {
  /**
   * Threshold for the console + testbench SSE output stream. Levels are
   * suppressed below this threshold:
   *   - 'silent': nothing
   *   - 'error':  errors only
   *   - 'warn':   errors + warnings
   *   - 'info':   errors + warnings + info (no debug noise)
   *   - 'debug':  everything, including BEGIN/END traceOp markers
   * The run log file always captures every level regardless of this setting.
   */
  consoleLogLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  /**
   * Per-run server log file mode:
   *   - 'off':     no file written
   *   - 'compact': inline log lines only (no AI request/response payloads)
   *   - 'full':    log lines + full AI request/response trace blocks
   */
  serverFileLogLevel: 'off' | 'compact' | 'full';
}

export interface Config {
  ai: AiConfig;
  browser: BrowserConfig;
  tests: TestsConfig;
  execution: ExecutionConfig;
  reports: ReportsConfig;
  api: ApiConfig;
  server: ServerConfig;
  cache: CacheConfig;
  logging: LoggingConfig;
}

/** Deeply partial version of Config for user-provided overrides */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type UserConfig = DeepPartial<Config>;
