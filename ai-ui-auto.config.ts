import { defineConfig } from './src/config/types.js';
import { DEFAULT_BROWSER_DIMENSIONS } from './src/config/browser-dimensions.js';

export default defineConfig({
  ai: {
    gatewayUrl: 'https://llm.corp.example',
    // apiKey: process.env.AI_API_KEY,
    model: 'gpt-5.4',
    maxInputTokens: 1_000_000,
    streamResponses: true,
  },
  browser: {
    headed: true,
    viewport: { ...DEFAULT_BROWSER_DIMENSIONS },
    windowSize: { ...DEFAULT_BROWSER_DIMENSIONS },
    slowMo: 0,
    browser: 'chromium',
  },
  tests: {
    dir: './fixtures/tests',
    contextDir: './fixtures/context',
    pattern: '**/*.md',
  },
  execution: {
    timeout: 60_000,
    retries: 1,
    screenshotOnFailure: true,
    dismissObstacles: true,
    promptOnAmbiguity: true,
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
    apiKey: (() => {
      const key = process.env.SERVER_API_KEY;
      if (!key) {
        throw new Error('SERVER_API_KEY is not set — add it to your .env file');
      }
      return key;
    })(),
  },
});
