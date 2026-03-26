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
}

export interface BrowserConfig {
  /** Show browser window (false = headless) */
  headed: boolean;
  /** Browser viewport dimensions */
  viewport: { width: number; height: number };
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

export interface Config {
  ai: AiConfig;
  browser: BrowserConfig;
  tests: TestsConfig;
  execution: ExecutionConfig;
  reports: ReportsConfig;
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
