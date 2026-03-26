import { defineConfig } from 'ai-ui-automation';

export default defineConfig({
  ai: {
    gatewayUrl: 'https://aiapi.example.com',
    // apiKey: process.env.AI_API_KEY,
    model: 'gpt-5.4',
  },
  browser: {
    headed: true,
    viewport: { width: 1280, height: 720 },
  },
  tests: {
    dir: './tests',
    contextDir: './context',
  },
  reports: {
    outputDir: './reports',
  },
});
