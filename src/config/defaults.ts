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
    ...(process.env['AI_API_KEY'] !== undefined && { apiKey: process.env['AI_API_KEY'] }),
    model: 'gpt-5.4-mini',
    maxInputTokens: 1_000_000,
    streamResponses: false,
    sendScreenshots: false,
  },
  browser: {
    headed: true,
    viewport: { ...DEFAULT_BROWSER_DIMENSIONS },
    windowSize: { ...DEFAULT_BROWSER_DIMENSIONS },
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
  server: {
    host: '127.0.0.1',
    port: 3100,
    apiKey: 'dev-api-key',
  },
  cache: {
    enabled: true,
    dir: '.cache',
  },
};
