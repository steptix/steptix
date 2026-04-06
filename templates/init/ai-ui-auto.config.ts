import { defineConfig } from 'ai-ui-automation';

const defaultBrowserDimensions = { width: 1280, height: 720 };

export default defineConfig({
  ai: {
    gatewayUrl: 'https://aiapi.example.com',
    // apiKey: process.env.AI_API_KEY,
    model: 'gpt-5.4',
  },
  browser: {
    headed: true,
    viewport: { ...defaultBrowserDimensions },
    windowSize: { ...defaultBrowserDimensions },
  },
  tests: {
    dir: './tests',
    contextDir: './context',
  },
  reports: {
    outputDir: './reports',
  },
});
