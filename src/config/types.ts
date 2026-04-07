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
}

export interface TestsConfig {
  /** Directory containing test .md files */
  dir: string;
  /** Directory containing context .md files */
  contextDir: string;
  /** Glob pattern for discovering test files */
  pattern: string;
}

export interface ExecutionConfig {
  /** Default test timeout in milliseconds */
  timeout: number;
  /** Number of retries per failed step */
  retries: number;
  /** Capture screenshot on step failure */
  screenshotOnFailure: boolean;
  /** Auto-dismiss unexpected modals and banners */
  dismissObstacles: boolean;
  /** Ask user when AI cannot determine next action */
  promptOnAmbiguity: boolean;
  /** Maximum number of AI turns per step for multi-turn execution (default: 5) */
  maxTurns: number;
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

export interface Config {
  ai: AiConfig;
  browser: BrowserConfig;
  tests: TestsConfig;
  execution: ExecutionConfig;
  reports: ReportsConfig;
  api: ApiConfig;
  server: ServerConfig;
}

/** Deeply partial version of Config for user-provided overrides */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type UserConfig = DeepPartial<Config>;

/** Helper function for type-safe config definition */
export function defineConfig(config: UserConfig): UserConfig {
  return config;
}
