import { defineConfig } from './src/config/types.js';
import { DEFAULT_BROWSER_DIMENSIONS } from './src/config/browser-dimensions.js';

export default defineConfig({
  ai: {
    gatewayUrl: 'https://llm.corp.example',
    // apiKey: process.env.AI_API_KEY,
    // model: defaulted via src/config/defaults.ts; override with AI_MODEL in .env
    maxInputTokens: 1_000_000,
    streamResponses: true,
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
    pattern: '**/*.md',
  },
  execution: {
    timeout: 3_600_000,
    retries: 1,
    screenshotOnFailure: true,
    dismissObstacles: false,
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
  },
  dom: {
    // Controls compact-mode DOM output for wrapper tags (e.g. <div>) that
    // have no id/data-testid but carry a `class` and contain interactive/
    // heading/landmark descendants.
    //   true  = CLOSER TO THE REAL DOM. Keep the wrapper (emitted as
    //           <div class="…">…</div>), giving the AI grouping context to
    //           disambiguate similar elements in different sections. Costs
    //           extra tokens and deeper nesting. Still omits purely empty
    //           layout divs, so not identical to the real DOM — just closer.
    //   false = FURTHER FROM THE REAL DOM. Flatten the wrapper away; its
    //           children are inlined at the parent's depth. Leaner output,
    //           less context, shallower tree than the actual page.
    preserveClassWrappers: true,
  },
});
