import { defineConfig } from './dist/config/types.js';
import { DEFAULT_BROWSER_DIMENSIONS } from './dist/config/browser-dimensions.js';

export default defineConfig({
  ai: {
    gatewayUrl: 'https://llm.corp.example',
    // apiKey: process.env.AI_API_KEY,
    // model: defaulted via src/config/defaults.ts; override with AI_MODEL in .env
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
    stealth: false,
    bypassCSP: false,
  },
  tests: {
    dir: './fixtures/tests',
    contextDir: './fixtures/context',
    skillsDir: './fixtures/skills',
    toolsDir: './fixtures/tools/src',
    pattern: '**/*.md',
  },
  execution: {
    timeout: 3_600_000,
    retries: 1,
    screenshotOnFailure: true,
    promptOnAmbiguity: true,
    // Example project-level hook — runs before every step of every test unless
    // the test sets `hooks: replace` in frontmatter, or the step is marked
    // [no-hooks]. Uncomment to enable.
    // defaultHooks: {
    //   beforeEach: ['[skill: dismiss_obstacles]'],
    // },
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
  },
  cache: {
    enabled: true,
    dir: '.cache',
  },
});
