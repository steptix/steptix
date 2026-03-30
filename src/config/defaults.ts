import type { Config } from './types.js';

export const DEFAULT_CONFIG: Config = {
  api: {
    specsDir: './specs',
    requestTimeout: 30_000,
    redactSensitive: true,
  },
  ai: {
    gatewayUrl: 'https://llm.corp.example',
    ...(process.env['AI_API_KEY'] !== undefined && { apiKey: process.env['AI_API_KEY'] }),
    model: 'gpt-5.4-mini',
    maxInputTokens: 1_000_000,
    streamResponses: true,
  },
  browser: {
    headed: true,
    viewport: { width: 1280, height: 720 },
    slowMo: 0,
    browser: 'chromium',
  },
  tests: {
    dir: './tests',
    contextDir: './context',
    pattern: '**/*.md',
  },
  execution: {
    timeout: 60_000,
    retries: 1,
    screenshotOnFailure: true,
    dismissObstacles: true,
    promptOnAmbiguity: true,
    maxTurns: 5,
  },
  reports: {
    outputDir: './reports',
    includeScreenshots: true,
    includeDomSnapshots: true,
    includeAiReasoning: true,
    embedScreenshots: true,
  },
};
