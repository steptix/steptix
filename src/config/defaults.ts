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
    model: 'openai/gpt-5.6-luna',
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
    // Today's behaviour: a singular action takes the first visible match.
    // 'fail' is the author's opt-in (stories/codebehind-selector-ambiguity.md).
    ambiguousTarget: 'first',
    maxIframeDepth: 5,
    domSnapshotCharLimit: 300_000,
    captureScreenshotsPerAction: false,
    video: 'off',
    cdp: { hideAutomation: false },
    domNoiseReduction: {
      collapseRepetitiveDom: true,
      compactSvg: true,
      hideHiddenInputs: true,
      hideDisplayNoneElements: true,
      hideAriaHiddenElements: true,
      useDomAttributeAllowlist: true,
      dropUnstableIds: false,
    },
  },
  tests: {
    dir: './tests',
    dataDir: 'data',
    contextDir: './context',
    skillsDir: './skills',
    toolsDir: './tools/src',
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
  // Code-behind has no config section. Execution needs no flag — a `.steps.ts`
  // beside a test is the author's intent, like a `tools/` directory — and
  // generation is no longer something a run does, so there is nothing left to
  // gate (stories/codebehind-compile.md).
  logging: {
    consoleLogLevel: 'info',
    serverFileLogLevel: 'compact',
  },
};
