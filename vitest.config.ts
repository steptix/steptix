import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Every run loop records to the scoreboard by default, and the scoreboard
    // lives in the REAL machine folder (`%LOCALAPPDATA%\steptix\stats`,
    // docs/specs/SPEC-scoreboard.md §6.1). Off for the whole suite, so no test
    // that drives a loop writes there; the tests that are ABOUT recording turn
    // it back on and point the user root at a temp folder of their own.
    env: { STEPTIX_STATS: 'off' },
    // Budgets for the whole suite running at once, not for one file alone.
    // While every worker is starting, a test that takes a second alone can
    // take several, and closing a Chromium can take tens of seconds — past
    // vitest's 5 s and 10 s defaults. A test or hook that hangs still fails.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
    },
  },
});
