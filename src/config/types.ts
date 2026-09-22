import type { Effort } from '@pkent/aigateway';

export interface AiConfig {
  /** Base URL for the aiapi gateway */
  gatewayUrl: string;
  /** Bearer token for authentication */
  apiKey?: string;
  /** Model identifier */
  model: string;
  /** Maximum input tokens per request */
  maxInputTokens: number;
  /**
   * Reasoning effort for ROUTINE calls (`AI_EFFORT`): one of `none`, `minimal`,
   * `low`, `medium`, `high`, `xhigh`, `max`. Unset means today's behavior — no
   * effort on the wire. The `retry` and `authoring` profiles set their own and
   * are deliberately NOT lowered by this: a global cost knob should not make
   * failure diagnosis worse.
   *
   * The generated JSON schema leaves this untyped because `Effort` resolves
   * through an ambient module declaration. That is deliberate rather than worked
   * around: restating the seven levels here would create a second source of
   * truth that goes stale the next time a provider adds one, and the gateway
   * already rejects an unknown level at the first call with `invalid_effort`.
   */
  effort?: Effort;
  /** Use streaming endpoint instead of vision */
  streamResponses: boolean;
  /** Include a screenshot in each AI request (set false to reduce token usage) */
  sendScreenshots: boolean;
  /** Run a post-failure AI diagnosis pass and attach the result to the report */
  diagnoseFailures: boolean;
  /**
   * May a run use AI at all? Default `true`, so absence is exactly today's
   * behaviour (stories/run-settings.md §9).
   *
   * The project-level floor under the per-session `ai` run setting: `false`
   * makes a run behave like a keyless one no matter which keys are configured —
   * compiled steps replay, and anything needing a model is skipped or refused.
   * Compile, repair and errands are deliberately NOT gated by it; they are
   * requests *for* AI.
   *
   * Scope: every path that runs a test — the Sessions API server (TestBench,
   * MCP, the HTTP API), the `aiui run` CLI and the Runner UI. The two
   * non-server paths resolve no run settings, so the per-session `ai` override
   * cannot reach them and this key is the whole switch there.
   *
   * Neither of those two honoured it until stories/bedrock-provider.md:
   * blanking `AI_API_KEY=` was a working substitute right up until a provider
   * that authenticates itself, where there is no key to blank and a CI user
   * would have had no way to force a no-AI run at all.
   */
  allowInRuns?: boolean;
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

/** How this framework launches a CDP browser (`start_cdp_browser`,
 *  `POST /cdp/browsers`). Read from the `aiui.config.json` of the root the
 *  browser is launched into — the project's, or the user root's for a
 *  machine-wide browser. Applies at launch only: a browser that is already
 *  running keeps whatever it was started with. */
export interface CdpBrowserConfig {
  /** Start the browser with `--disable-blink-features=AutomationControlled`,
   *  so pages read `navigator.webdriver` as `false` the way they do in a
   *  Chrome started by hand. A remote-debuggable Chrome otherwise reports
   *  `true` to every page, and some sites refuse a browser that says so —
   *  which defeats the point of a browser a human signs into. While it is on,
   *  Chrome shows its "unsupported command-line flag" bar on launch; dismiss
   *  it. A human-held choice, deliberately a config file setting and not a
   *  tool argument. Default false. */
  hideAutomation?: boolean | undefined;
}

export interface BrowserConfig {
  /** Show browser window (false = headless) */
  headed: boolean;
  /** Headless browser viewport dimensions */
  viewport: { width: number; height: number };
  /** Headed browser window dimensions */
  windowSize: { width: number; height: number };
  /** When set, every context this launch creates gets EXACTLY this viewport —
   *  headed or headless — instead of the viewport/windowSize pair. Set by the
   *  runner/server from a test's `## Config: viewport:`; settable in
   *  aiui.config.json to pin a whole project (stories/per-test-viewport.md §8).
   *
   *  The three sizing keys are NOT interchangeable, and the distinction is the
   *  reason this one exists: `viewport` applies headless only, `windowSize`
   *  sizes the headed WINDOW (whose page area is then whatever is left after
   *  browser chrome), and `fixedViewport` pins the PAGE in both modes — which
   *  is the only one of the three a CSS-breakpoint test can rely on.
   *
   *  Refused by the CDP attach path: the browser is the user's own and its
   *  size is theirs (§2). */
  fixedViewport?: { width: number; height: number };
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
  /** What a SINGULAR action does when its selector resolves to more than one
   *  candidate element. `'first'` (default, and today's behaviour) acts on the
   *  first of them; `'fail'` refuses to act and returns the count, which flows
   *  into the turn's collected failures and reaches the AI as "3 elements
   *  matched — use a more specific selector". The AI then re-plans, usually by
   *  scoping to a container. The rule it enforces: don't let the AI resolve
   *  ambiguity by accident.
   *
   *  "More than one" is measured against EACH ACTION'S OWN tolerance — the
   *  question is always "did this action's `.first()` pick from more than one
   *  candidate?". Click, type, select, hover and upload filter to visible
   *  before taking the first, so they gate on the VISIBLE count. A singular
   *  `read` takes `.first()` over every match (reading a hidden element is
   *  legitimate, so it waits for attachment rather than visibility), so it
   *  gates on the TOTAL. Gating a read on the visible count would let it
   *  capture out of a hidden first match while reporting one visible
   *  candidate — the worse of the two failures, since a wrong click fails
   *  loudly and a wrong read silently poisons a variable later steps trust.
   *
   *  For the visible-filtered actions this is deliberately NOT the total, and
   *  the distinction is the design rather than an implementation detail.
   *  Gating those on ALL matches was considered and declined: it would give
   *  literal parity with Playwright's strict mode, but it would fail the
   *  common case where a selector matches one visible element plus a hidden
   *  duplicate (the mobile-nav drawer, the print-only copy) — a case where the
   *  AI is demonstrably right and only the generated code-behind needed
   *  fixing. Read gating on the total is not an exception to that reasoning
   *  but an application of it: a read has no visible filter to be right about.
   *  The recorded measurement already hands generation a verified unique handle
   *  there, so failing the run would be pure cost.
   *
   *  What `'fail'` buys is the case measurement cannot settle: three visible
   *  matches, the AI took the first, and no amount of counting says whether it
   *  was the one the step meant. Only the AI can settle it, and only by being
   *  told its selector was ambiguous.
   *
   *  Off by default because it changes the behaviour of a path that currently
   *  works, costs an AI turn each time it fires, and can turn a green test red
   *  — which is the point, and is therefore the author's call about a suite
   *  rather than a guess the framework makes on their behalf.
   *
   *  Plural actions are exempt by construction (`read` with `multiple: true`,
   *  `count`): many matches is their purpose. Unrelated to
   *  `execution.promptOnAmbiguity`, which asks the HUMAN when the AI cannot
   *  determine the next action. See stories/codebehind-selector-ambiguity.md. */
  ambiguousTarget?: 'first' | 'fail' | undefined;
  /** Launch settings for CDP browsers this framework starts. See
   *  CdpBrowserConfig. Nothing here applies to a browser attached to by port. */
  cdp?: CdpBrowserConfig | undefined;
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
  /** Record a `.webm` video of the browser session, surfaced as a `<video>`
   *  link in the HTML report. Tri-state, matching Playwright's own `video`
   *  vocabulary:
   *    - `'off'` (default): record nothing.
   *    - `'on'`: record every run and keep the file.
   *    - `'retain-on-failure'`: record every run but delete the file on a
   *      passing run, keeping it only for failed/aborted runs.
   *  Boolean `true`/`false` are accepted as sugar for `'on'`/`'off'`.
   *  The `| boolean` arm is REQUIRED so the generated JSON schema (built from
   *  `UserConfig`) accepts `"video": true/false` instead of enum-rejecting it.
   *  Default 'off'. */
  video?: 'off' | 'on' | 'retain-on-failure' | boolean | undefined;
  /** Extra Chromium command-line arguments, appended to the `--window-size`
   *  the launcher already passes (docs/specs/SPEC-use-computer.md §5.10).
   *
   *  It exists for the two cases where what a test needs to drive is decided
   *  by a browser flag rather than by anything in the page. The measured one:
   *  `--disable-print-preview` makes Chromium's Print button open the
   *  OPERATING SYSTEM's print dialog instead of its own preview, which is a
   *  native window and therefore reachable from computer mode. The other is
   *  `--ozone-platform=x11` on a Wayland desktop, without which the browser
   *  and its GTK dialogs are not X11 windows and libnut cannot see them
   *  (§11).
   *
   *  Chromium only, and applies at LAUNCH: a browser attached to over CDP is
   *  the user's own and was started with whatever it was started with. */
  launchArgs?: string[] | undefined;
}

/**
 * The computer surface (docs/specs/SPEC-use-computer.md §5.10).
 *
 * Every key here is per project, in `aiui.config.json`, and `enabled` is the
 * reason the section exists at all: a test file in a shared repository must
 * not be able to move the mouse on a machine whose owner did not allow it
 * (§5.1 item 1).
 *
 * Required on `Config`, with a `defaults.ts` entry, unlike `mcp` —
 * `desktop.enabled` is read on every `[use computer]`, and a missing section
 * must read as "off" rather than as `undefined`.
 *
 * The doc comment lives HERE and not on `Config.desktop`, which is not a
 * style preference: `ts-json-schema-generator` names a REQUIRED property's
 * type anonymously (`DeepPartial<def-interface-…-13661-15026-…>`) when the
 * property itself carries a JSDoc, so the generated schema gains an unreadable
 * definition key that churns on every edit to the file above it. Measured
 * 2026-09-23 while adding this section; `mcp` does not show it because an
 * OPTIONAL property takes a different path through the generator.
 */
export interface DesktopConfig {
  /** Opt in to `[use computer]` for this project. Default false; with it off,
   *  the directive fails the step and says so (§5.1 item 1). */
  enabled: boolean;
  /** The longer side, in pixels, of the screenshot the model is shown (§5.2).
   *  A full-screen grab is downscaled to fit and never upscaled; a `zoom` is
   *  scaled UP to this, which is what makes small print readable on a
   *  downscaled 4K desktop. Default 1600. */
  maxImageWidth: number;
  /** Milliseconds to wait after any action that touches the screen, before
   *  the next capture (§5.5). Native UIs redraw asynchronously and a dialog
   *  takes a moment to appear. Default 300. */
  settleMs: number;
  /** Embed desktop captures in the HTML report (§10.1). A desktop capture is
   *  the WHOLE SCREEN, including whatever else is on it, and the text
   *  redaction in `src/utils/secrets.ts` cannot mask pixels — so this switch
   *  is about privacy, not about report size. Default true. */
  reportScreenshots: boolean;
}

export interface TestsConfig {
  /** Directory containing test .md files */
  dir: string;
  /** Directory containing per-environment JSON data files, resolved relative to
   *  the project root (the dir holding `aiui.config.json`). `${data.X}` loads
   *  `<dataDir>/<envName>.json`. Default `data`. A leading slash / drive root is
   *  treated as an absolute path; use `./data` for the project-relative form.
   *  Replaces the former `AIUI_DATA_DIR` env var. */
  dataDir: string;
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
  /**
   * Cap on the passes a single `While` or `Repeat … until` loop line may make
   * before the framework gives up (default: 25). A per-line `, up to N times`
   * suffix overrides it for that line; `For each` ignores it, since the list is
   * its bound.
   *
   * Reaching the cap with the exit condition still unmet **fails the loop line**
   * rather than exiting quietly — a loop that hit its cap has not done what the
   * author asked (stories/control-flow.md, decision 9).
   */
  maxLoopIterations: number;
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
  /**
   * Shut the server down after this many minutes with **no run in flight and
   * no authenticated API request** — deliberately not "no open sessions",
   * since TestBench keeps sessions open for reuse indefinitely and a
   * session-count rule would never fire. `GET /health` is unauthenticated and
   * never resets the timer, so the status bar's poll can't keep the server
   * alive. The idle shutdown closes any open sessions (browsers included) on
   * its way out.
   *
   * Absent or 0 ⇒ run forever (today's behaviour for manual launches).
   * `serve --idle-timeout <minutes>` overrides this. Optional on purpose:
   * there is no `defaults.ts` entry, so absence stays absence through
   * `deepMerge`. See stories/server-lifecycle.md §3.
   */
  idleTimeoutMinutes?: number;
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

/**
 * How much reach an MCP agent has over CDP browsers.
 *
 * Lives in `aiui.config.json` rather than in a tool argument on purpose. The
 * existing `allow_foreign_session` precedent is the right *shape* but the
 * wrong *gate* here: an agent sets its own boolean, so it stops accidents, not
 * a page that talks the agent into setting one — and behind this gate sits a
 * browser holding live logged-in sessions. A config file is the only gate a
 * human actually holds.
 *
 * See stories/mcp-cdp-browser.md §6.
 */
export interface McpCdpConfig {
  /**
   * Let an agent attach to a CDP browser this project's framework did not
   * launch, and stop withholding foreign browsers' tab titles and URLs.
   *
   * Default false. This is the only setting that widens an agent's reach, and
   * a refusal names it precisely so the agent can ask the user for it instead
   * of silently failing or probing other ports.
   */
  allowUnowned?: boolean;
  /**
   * Override the port list swept when looking for browsers this project did
   * not start. Default `[9222, 9223, 9229]`.
   *
   * Discovery only — nothing here influences what we launch on. Our own
   * browsers pick their own ports (§3) and are found through the registry,
   * never by scanning.
   */
  ports?: number[];
}

export interface McpConfig {
  cdp?: McpCdpConfig;
}

/**
 * What gets photographed during a run — the TOOL's vocabulary, not a config
 * key (stories/run-settings.md §3).
 *
 * `captureScreenshotsPerAction` and `screenshotOnFailure` describe a four-cell
 * matrix with three meaningful cells, so this enum names those three and the
 * server maps it back onto the two booleans. `default` means "stop overriding
 * and use the project/server value" — without it, restoring the base would
 * require the caller to already know what it is.
 */
export type CaptureMode = 'every-step' | 'on-failure' | 'none' | 'default';

/**
 * Whether AI may be used during a run (stories/run-settings.md §9).
 *
 * `off` does not invent a mode — it reuses keyless: compiled steps replay, a
 * broken entry takes the skip instead of healing, and a step that needs a model
 * is refused. `default` clears the override and falls back to `ai.allowInRuns`.
 */
export type AiMode = 'on' | 'off' | 'default';

/**
 * Why AI was off for a run. Support has to tell these apart: `'policy'` is
 * somebody's stated intent and the key is fine; `'no-key'` is a machine with
 * nothing configured, and the advice is the opposite in each case.
 */
export type AiOffReason = 'policy' | 'no-key';

/**
 * Per-session overrides for how a run behaves, applied per request and
 * RETAINED on the session (stories/run-settings.md §1–§2).
 *
 * Deliberately not part of `Config`: nothing here is a config-file key, and
 * nothing here is ever written to `aiui.config.json`. Every field is
 * independently optional — a request carrying `{capture}` changes capture and
 * leaves the model alone. `null` on the model and the booleans, and `'default'`
 * on the enum, clear that one override and fall back to the project/server
 * value; an ABSENT key means "leave whatever this session already has".
 */
export interface RunSettings {
  /** Model for the next batch onward. Passed through to the gateway verbatim —
   *  it is the authority on which models exist. `null` clears the override. */
  model?: string | null;
  capture?: CaptureMode;
  /** `browser.fullPageScreenshots`. */
  fullPage?: boolean | null;
  /** `ai.sendScreenshots` — whether the MODEL sees the image while it works,
   *  which is the main cost lever on a run. */
  sendScreenshots?: boolean | null;
  /** Whether AI may be used at all during the run. `'default'` falls back to
   *  the project's `ai.allowInRuns`. */
  ai?: AiMode;
}

/** Which layer decided a setting's value. */
export type SettingSource = 'server' | 'project' | 'session';

/**
 * What a run actually ran under, and where each value came from
 * (stories/run-settings.md §5).
 *
 * The server is the only party that can report this: the MCP client does not
 * know the server's defaults, and reading the project file itself would answer
 * a different question ("what does the file say", not "what did this run use").
 *
 * `capture` carries a fourth value the tool enum does not: `'custom'`, for the
 * one boolean pair the enum cannot express (per-action capture on, failure
 * capture off). It is only reachable from a hand-written `aiui.config.json`,
 * and naming it is more honest than rounding it to `'every-step'`.
 */
export interface EffectiveSettings {
  model: string;
  capture: 'every-step' | 'on-failure' | 'none' | 'custom';
  fullPage: boolean;
  sendScreenshots: boolean;
  /** Whether this run could use AI. `'off'` covers both a policy that forbids
   *  it and a machine with no key — {@link aiOffReason} says which. */
  ai: 'on' | 'off';
  /** Why {@link ai} is `'off'`; `null` when it is on. Reported rather than
   *  inferred because the two states need opposite advice, and a key IS present
   *  on the policy path. */
  aiOffReason: AiOffReason | null;
  sources: {
    model: SettingSource;
    capture: SettingSource;
    fullPage: SettingSource;
    sendScreenshots: SettingSource;
    /** Which layer decided the AI POLICY. A missing key does not move this:
     *  it is not a setting anybody chose. */
    ai: SettingSource;
  };
}

export interface Config {
  ai: AiConfig;
  browser: BrowserConfig;
  desktop: DesktopConfig;
  tests: TestsConfig;
  execution: ExecutionConfig;
  reports: ReportsConfig;
  api: ApiConfig;
  server: ServerConfig;
  cache: CacheConfig;
  logging: LoggingConfig;
  /**
   * MCP-only settings. Optional, and deliberately without a `defaults.ts`
   * entry so absence stays absence through `deepMerge` — the same treatment as
   * `server.idleTimeoutMinutes`. Declared here for the rest of the framework
   * and for the generated JSON schema; the MCP path reads the raw parsed
   * config rather than the loader (stories/mcp-server.md §3), so this
   * declaration is documentation and schema, not the read path.
   */
  mcp?: McpConfig;
}

/** Deeply partial version of Config for user-provided overrides */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type UserConfig = DeepPartial<Config>;
