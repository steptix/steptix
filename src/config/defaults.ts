import type { Config } from './types.js';
import { DEFAULT_BROWSER_DIMENSIONS } from './browser-dimensions.js';

export const DEFAULT_CONFIG: Config = {
  api: {
    specsDir: './specs',
    requestTimeout: 30_000,
    redactSensitive: true,
  },
  ai: {
    gatewayUrl: 'https://llm.corp.example',
    model: 'gpt-5.4-mini',
    maxInputTokens: 1_000_000,
    streamResponses: false,
    sendScreenshots: false,
    diagnoseFailures: true,
  },
  browser: {
    headed: true,
    viewport: { ...DEFAULT_BROWSER_DIMENSIONS },
    windowSize: { ...DEFAULT_BROWSER_DIMENSIONS },
    slowMo: 0,
    browser: 'chromium',
    fullPageScreenshots: false,
    collapseRepetitiveDom: true,
    compactSvg: true,
    hideHiddenInputs: true,
    hideDisplayNoneElements: true,
    hideAriaHiddenElements: true,
    maxIframeDepth: 5,
    domSnapshotCharLimit: 300_000,
    captureScreenshotsPerAction: false,
    useDomAttributeAllowlist: true,
    dropUnstableIds: true,
  },
  tests: {
    dir: './tests',
    contextDir: './context',
    skillsDir: './skills',
    pattern: '**/*.md',
  },
  execution: {
    timeout: 3600_000,
    retries: 1,
    screenshotOnFailure: true,
    promptOnAmbiguity: true,
    maxTurns: 15,
    interactiveOnFailure: false,
  },
  reports: {
    outputDir: './reports',
    includeScreenshots: true,
    includeDomSnapshots: true,
    includeAiReasoning: true,
    embedScreenshots: true,
    openInBrowserAfterRun: false,
    appendRunHistoryToTestFile: false,
  },
  server: {
    host: '127.0.0.1',
    port: 3100,
    apiKey: 'dev-api-key',
  },
  cache: {
    enabled: false,
    dir: '.cache',
  },
  logging: {
    consoleLogLevel: 'info',
    serverFileLogLevel: 'compact',
  },
};
