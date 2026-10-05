import type { Config } from './types.js';
import { DEFAULT_BROWSER_DIMENSIONS } from './browser-dimensions.js';

export const DEFAULT_CONFIG: Config = {
  api: {
    specsDir: './specs',
    requestTimeout: 30_000,
    redactSensitive: true,
  },
  ai: {
    model: 'openai/gpt-5.6-luna',
    maxInputTokens: 1_000_000,
    streamResponses: false,
    sendScreenshots: false,
    diagnoseFailures: true,
    allowInRuns: true,
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
  // docs/specs/SPEC-use-computer.md §5.10. Off by default and deliberately so:
  // this is the section that decides whether a test file may move this
  // machine's mouse (§5.1 item 1).
  desktop: {
    enabled: false,
    maxImageWidth: 1600,
    settleMs: 300,
    reportScreenshots: true,
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
    maxLoopIterations: 25,
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
  // Code-behind has no config section. Execution needs no flag — a `.steps.ts`
  // beside a test is the author's intent, like a `tools/` directory — and
  // generation is no longer something a run does, so there is nothing left to
  // gate (stories/codebehind-compile.md).
  logging: {
    consoleLogLevel: 'info',
    serverFileLogLevel: 'compact',
  },
  // Structured table reads (SPEC-structured-table-reads.md §7.10). `ask` is
  // the default because the question is asked at most ONCE per structure per
  // run — the cost of the long tail of odd
  // grids reading at all. `strict` turns it off for a run that must spend no
  // unplanned model call.
  tables: {
    structure: 'ask',
  },
};
